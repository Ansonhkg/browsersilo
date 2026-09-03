import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import {
  DecryptCommand,
  EncryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
  type DecryptCommandOutput,
  type EncryptCommandOutput,
  type GenerateDataKeyCommandOutput,
} from "@aws-sdk/client-kms";

const LOCAL_MAGIC = Buffer.from("BSLK1");
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface EnvelopeContext {
  profileId: string;
  purpose: "browser-profile" | "artifact";
}

export interface GeneratedDataKey {
  plaintext: Buffer;
  wrapped: Buffer;
  keyId: string;
}

export interface KeyManagementPort {
  readonly provider: "local" | "aws-kms";
  readonly activeKeyId: string;
  generateDataKey(context: EnvelopeContext): Promise<GeneratedDataKey>;
  wrapDataKey(
    plaintext: Buffer,
    context: EnvelopeContext,
  ): Promise<{ wrapped: Buffer; keyId: string }>;
  unwrapDataKey(
    wrapped: Buffer,
    keyId: string,
    context: EnvelopeContext,
  ): Promise<Buffer>;
}

export class LocalKeyManagement implements KeyManagementPort {
  readonly provider = "local" as const;
  readonly activeKeyId: string;
  readonly #masterKey: Buffer;

  constructor(masterKey: Buffer, keyId = "local-development-key") {
    if (masterKey.length !== 32) throw new Error("Local master key must be 32 bytes.");
    this.#masterKey = Buffer.from(masterKey);
    this.activeKeyId = keyId;
  }

  async generateDataKey(context: EnvelopeContext): Promise<GeneratedDataKey> {
    const plaintext = randomBytes(32);
    const wrapped = await this.wrapDataKey(plaintext, context);
    return { plaintext, ...wrapped };
  }

  async wrapDataKey(
    plaintext: Buffer,
    context: EnvelopeContext,
  ): Promise<{ wrapped: Buffer; keyId: string }> {
    if (plaintext.length !== 32) throw new Error("Data key must be 32 bytes.");
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#masterKey, iv);
    cipher.setAAD(contextBytes(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      wrapped: Buffer.concat([
        LOCAL_MAGIC,
        iv,
        cipher.getAuthTag(),
        ciphertext,
      ]),
      keyId: this.activeKeyId,
    };
  }

  async unwrapDataKey(
    wrapped: Buffer,
    keyId: string,
    context: EnvelopeContext,
  ): Promise<Buffer> {
    if (keyId !== this.activeKeyId) {
      throw new Error(`Local KMS key ${keyId} is not available.`);
    }
    const minimum = LOCAL_MAGIC.length + IV_BYTES + TAG_BYTES + 1;
    if (
      wrapped.length < minimum ||
      !wrapped.subarray(0, LOCAL_MAGIC.length).equals(LOCAL_MAGIC)
    ) {
      throw new Error("The wrapped data key has an invalid local envelope.");
    }
    const ivStart = LOCAL_MAGIC.length;
    const tagStart = ivStart + IV_BYTES;
    const ciphertextStart = tagStart + TAG_BYTES;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#masterKey,
      wrapped.subarray(ivStart, tagStart),
    );
    decipher.setAAD(contextBytes(context));
    decipher.setAuthTag(wrapped.subarray(tagStart, ciphertextStart));
    const plaintext = Buffer.concat([
      decipher.update(wrapped.subarray(ciphertextStart)),
      decipher.final(),
    ]);
    if (plaintext.length !== 32) throw new Error("Unwrapped data key is invalid.");
    return plaintext;
  }
}

export interface AwsKmsKeyManagementOptions {
  keyId: string;
  region?: string;
  endpoint?: string;
  client?: AwsKmsClient;
}

export interface AwsKmsClient {
  send(command: GenerateDataKeyCommand): Promise<GenerateDataKeyCommandOutput>;
  send(command: EncryptCommand): Promise<EncryptCommandOutput>;
  send(command: DecryptCommand): Promise<DecryptCommandOutput>;
}

export class AwsKmsKeyManagement implements KeyManagementPort {
  readonly provider = "aws-kms" as const;
  readonly activeKeyId: string;
  readonly #client: AwsKmsClient;

  constructor(options: AwsKmsKeyManagementOptions) {
    if (!options.keyId) throw new Error("An AWS KMS key id is required.");
    this.activeKeyId = options.keyId;
    this.#client = options.client ?? new KMSClient({
      ...(options.region ? { region: options.region } : {}),
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    });
  }

  async generateDataKey(context: EnvelopeContext): Promise<GeneratedDataKey> {
    const result = await this.#client.send(
      new GenerateDataKeyCommand({
        KeyId: this.activeKeyId,
        KeySpec: "AES_256",
        EncryptionContext: awsContext(context),
      }),
    );
    if (!result.Plaintext || !result.CiphertextBlob || !result.KeyId) {
      throw new Error("AWS KMS returned an incomplete data key.");
    }
    return {
      plaintext: Buffer.from(result.Plaintext),
      wrapped: Buffer.from(result.CiphertextBlob),
      keyId: result.KeyId,
    };
  }

  async wrapDataKey(
    plaintext: Buffer,
    context: EnvelopeContext,
  ): Promise<{ wrapped: Buffer; keyId: string }> {
    const result = await this.#client.send(
      new EncryptCommand({
        KeyId: this.activeKeyId,
        Plaintext: plaintext,
        EncryptionContext: awsContext(context),
      }),
    );
    if (!result.CiphertextBlob || !result.KeyId) {
      throw new Error("AWS KMS returned an incomplete wrapped key.");
    }
    return { wrapped: Buffer.from(result.CiphertextBlob), keyId: result.KeyId };
  }

  async unwrapDataKey(
    wrapped: Buffer,
    keyId: string,
    context: EnvelopeContext,
  ): Promise<Buffer> {
    const result = await this.#client.send(
      new DecryptCommand({
        KeyId: keyId,
        CiphertextBlob: wrapped,
        EncryptionContext: awsContext(context),
      }),
    );
    if (!result.Plaintext) throw new Error("AWS KMS returned no plaintext key.");
    const plaintext = Buffer.from(result.Plaintext);
    if (plaintext.length !== 32) throw new Error("AWS KMS data key is invalid.");
    return plaintext;
  }
}

function contextBytes(context: EnvelopeContext): Buffer {
  return Buffer.from(
    JSON.stringify({ profileId: context.profileId, purpose: context.purpose }),
  );
}

function awsContext(context: EnvelopeContext): Record<string, string> {
  return {
    "browsersilo:profile-id": context.profileId,
    "browsersilo:purpose": context.purpose,
  };
}

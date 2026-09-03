import assert from "node:assert/strict";
import test from "node:test";
import {
  DecryptCommand,
  EncryptCommand,
  GenerateDataKeyCommand,
  type DecryptCommandOutput,
  type EncryptCommandOutput,
  type GenerateDataKeyCommandOutput,
} from "@aws-sdk/client-kms";
import {
  AwsKmsKeyManagement,
  LocalKeyManagement,
  type AwsKmsClient,
} from "../src/security/key-management.js";

test("local envelope keys are unique and bound to profile and purpose", async () => {
  const kms = new LocalKeyManagement(Buffer.alloc(32, 17), "local-test-key");
  const profile = { profileId: "profile-a", purpose: "browser-profile" as const };
  const first = await kms.generateDataKey(profile);
  const second = await kms.generateDataKey(profile);

  assert.equal(first.keyId, "local-test-key");
  assert.notDeepEqual(first.plaintext, second.plaintext);
  assert.notDeepEqual(first.wrapped, second.wrapped);
  assert.deepEqual(
    await kms.unwrapDataKey(first.wrapped, first.keyId, profile),
    first.plaintext,
  );
  await assert.rejects(() =>
    kms.unwrapDataKey(first.wrapped, first.keyId, {
      profileId: "profile-b",
      purpose: "browser-profile",
    }),
  );
  await assert.rejects(() =>
    kms.unwrapDataKey(first.wrapped, first.keyId, {
      profileId: "profile-a",
      purpose: "artifact",
    }),
  );
});

test("AWS KMS adapter sends the required encryption context for every key operation", async () => {
  const client = new RecordingKmsClient();
  const kms = new AwsKmsKeyManagement({ keyId: "alias/browsersilo", client });
  const context = { profileId: "profile-aws", purpose: "browser-profile" as const };

  const generated = await kms.generateDataKey(context);
  const wrapped = await kms.wrapDataKey(Buffer.alloc(32, 23), context);
  const plaintext = await kms.unwrapDataKey(wrapped.wrapped, wrapped.keyId, context);

  assert.equal(generated.keyId, "arn:aws:kms:test:key/one");
  assert.equal(plaintext.length, 32);
  assert.equal(client.inputs.length, 3);
  for (const input of client.inputs) {
    assert.deepEqual(input.EncryptionContext, {
      "browsersilo:profile-id": "profile-aws",
      "browsersilo:purpose": "browser-profile",
    });
  }
});

class RecordingKmsClient implements AwsKmsClient {
  readonly inputs: Array<Record<string, unknown>> = [];

  async send(command: GenerateDataKeyCommand): Promise<GenerateDataKeyCommandOutput>;
  async send(command: EncryptCommand): Promise<EncryptCommandOutput>;
  async send(command: DecryptCommand): Promise<DecryptCommandOutput>;
  async send(
    command: GenerateDataKeyCommand | EncryptCommand | DecryptCommand,
  ): Promise<GenerateDataKeyCommandOutput | EncryptCommandOutput | DecryptCommandOutput> {
    this.inputs.push(command.input as Record<string, unknown>);
    const metadata = { $metadata: {} };
    if (command instanceof GenerateDataKeyCommand) {
      return {
        ...metadata,
        KeyId: "arn:aws:kms:test:key/one",
        Plaintext: Buffer.alloc(32, 19),
        CiphertextBlob: Buffer.from("generated-wrapped-key"),
      };
    }
    if (command instanceof EncryptCommand) {
      return {
        ...metadata,
        KeyId: "arn:aws:kms:test:key/one",
        CiphertextBlob: Buffer.from("encrypted-wrapped-key"),
      };
    }
    return { ...metadata, Plaintext: Buffer.alloc(32, 23) };
  }
}

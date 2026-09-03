import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CircleGauge, Box, Users } from "lucide-react";
import { DashboardShell } from "./dashboard-shell";

const navigation = [
  { to: "/", label: "Overview", icon: CircleGauge },
  { to: "/workers", label: "Workers", icon: Box },
  { to: "/profiles", label: "Profiles", icon: Users },
];

function setup() {
  const navigate = vi.fn();
  function Harness() {
    const [pathname, setPathname] = useState("/");
    const [theme, setTheme] = useState<"dark" | "light">("dark");
    return <DashboardShell brand={<strong>BrowserSilo</strong>} navigation={navigation} pathname={pathname} navigate={(href) => { navigate(href); setPathname(href); }} theme={theme} setTheme={setTheme}><h1>{pathname}</h1></DashboardShell>;
  }
  render(<Harness />);
  return { user: userEvent.setup(), navigate };
}

describe("open-source dashboard shell", () => {
  it("navigates client-side and marks the active page", async () => {
    const { user, navigate } = setup();
    await user.click(within(screen.getByRole("navigation", { name: "Primary navigation" })).getByRole("link", { name: "Workers" }));
    expect(navigate).toHaveBeenCalledWith("/workers");
    expect(screen.getByRole("link", { name: "Workers" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Overview" }).hasAttribute("aria-current")).toBe(false);
  });

  it("preserves modified-click link behavior", () => {
    const { navigate } = setup();
    const link = screen.getByRole("link", { name: "Workers" });
    // Cancel the browser default after the React handler to avoid jsdom navigation.
    const cancelDefault = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("click", cancelDefault);
    fireEvent.click(link, { ctrlKey: true });
    document.removeEventListener("click", cancelDefault);
    expect(navigate).not.toHaveBeenCalled();
    expect(link.getAttribute("href")).toBe("/workers");
  });

  it("collapses the sidebar while keeping links labelled and toggles the theme", async () => {
    const { user } = setup();
    const toggle = screen.getByRole("button", { name: "Toggle sidebar" });
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("link", { name: "Workers" }).title).toBe("Workers");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Use light mode" }));
    expect(screen.getByRole("button", { name: "Use dark mode" })).toBeTruthy();
  });

  it("opens search, filters, navigates with Enter, and restores focus", async () => {
    const { user, navigate } = setup();
    const trigger = screen.getByRole("button", { name: "Search" });
    await user.click(trigger);
    const input = await screen.findByRole("combobox");
    await waitFor(() => expect(document.activeElement).toBe(input));
    await user.type(input, "workers");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(navigate).toHaveBeenCalledWith("/workers");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("supports Ctrl/Cmd K, arrow navigation, Escape, and fresh search state on reopen", async () => {
    const { user, navigate } = setup();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("combobox");
    await waitFor(() => expect(document.activeElement).toBe(input));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(navigate).toHaveBeenCalledWith("/workers");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await user.type(await screen.findByRole("combobox"), "no-such-page");
    expect(screen.getByText("No pages found.")).toBeTruthy();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect((await screen.findByRole("combobox") as HTMLInputElement).value).toBe("");
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("closes mobile navigation after selecting a page, Escape, or the close button", async () => {
    const { user, navigate } = setup();
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    await user.click(trigger);
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    await user.click(within(drawer).getByRole("link", { name: "Profiles" }));
    expect(navigate).toHaveBeenCalledWith("/profiles");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await user.click(trigger);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(trigger);
    await user.click(await screen.findByRole("button", { name: "Close navigation" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps keyboard focus inside an open modal", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Search" }));
    const dialog = await screen.findByRole("dialog", { name: "Search BrowserSilo" });
    for (let step = 0; step < 6; step++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it("clears search without closing the palette", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Search" }));
    const input = await screen.findByRole("combobox");
    await user.type(input, "workers");
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect((input as HTMLInputElement).value).toBe("");
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(document.activeElement).toBe(input);
  });

  it("closes the drawer when the viewport returns to desktop", async () => {
    const { user } = setup();
    const media = vi.mocked(window.matchMedia).mock.results.find((result) => result.value.media === "(min-width: 768px)")!.value;
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    await screen.findByRole("dialog", { name: "Navigation" });
    media.matches = true;
    const onChange = media.addEventListener.mock.calls[0][1];
    const { act } = await import("@testing-library/react");
    await act(() => onChange());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

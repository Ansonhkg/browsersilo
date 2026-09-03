import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Kbd, Modal, Tooltip } from "@heroui/react";
import { Command } from "cmdk";
import { Delete, Menu, Moon, PanelLeft, Search, Sun, X, type LucideIcon } from "lucide-react";
import "./dashboard-shell.css";

interface NavigationItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

interface DashboardShellProps {
  children: ReactNode;
  brand: ReactNode;
  navigation: readonly NavigationItem[];
  pathname: string;
  navigate: (href: string) => void;
  theme: "dark" | "light";
  setTheme: (theme: "dark" | "light") => void;
}

/** BrowserSilo-owned layout; interactive primitives are from the free HeroUI package. */
export function DashboardShell({ children, brand, navigation, pathname, navigate, theme, setTheme }: DashboardShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const mainRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLButtonElement>(null);
  const commandInputRef = useRef<HTMLInputElement>(null);

  const openSearch = () => {
    // Give keyboard-opened dialogs the same reliable focus-return target as click-opened ones.
    searchRef.current?.focus();
    setSearchQuery("");
    setCommandOpen(true);
  };

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !event.repeat) {
        event.preventDefault();
        if (!mobileOpen) openSearch();
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [mobileOpen]);

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, behavior: "auto" });
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    const closeOnDesktop = () => { if (desktop.matches) setMobileOpen(false); };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  const links = (mobile = false) => (
    <nav aria-label={mobile ? "Mobile navigation" : "Primary navigation"} className="bs-nav">
      <p className="bs-nav-heading">Control plane</p>
      {navigation.map((item) => (
        <a
          key={item.to}
          href={item.to}
          className="bs-nav-link"
          aria-current={pathname === item.to ? "page" : undefined}
          aria-label={item.label}
          title={!mobile && collapsed ? item.label : undefined}
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            setMobileOpen(false);
            navigate(item.to);
          }}
        >
          <item.icon aria-hidden="true" />
          <span className="bs-nav-label">{item.label}</span>
        </a>
      ))}
    </nav>
  );

  const themeLabel = `Use ${theme === "dark" ? "light" : "dark"} mode`;

  return (
    <>
      <div className="bs-shell" data-collapsed={collapsed}>
        <a className="bs-skip-link" href="#bs-main">Skip to content</a>
        <aside className="bs-sidebar" aria-label="Sidebar">
          <div className="bs-sidebar-brand">{brand}</div>
          {links()}
          <div className="bs-sidebar-footer" title="Admin API connected">
            <span className="size-2 shrink-0 rounded-full bg-success" />
            <span className="bs-sidebar-footer-copy">Admin API connected</span>
          </div>
        </aside>
        <div className="bs-shell-content">
          <header className="bs-navbar">
            <Tooltip>
              <Button className="bs-mobile-toggle" isIconOnly variant="ghost" aria-label="Open navigation" aria-expanded={mobileOpen} aria-haspopup="dialog" onPress={() => setMobileOpen(true)}>
                <Menu aria-hidden="true" />
              </Button>
              <Tooltip.Content>Open navigation</Tooltip.Content>
            </Tooltip>
            <Tooltip>
              <Button className="bs-desktop-toggle" isIconOnly variant="ghost" aria-label="Toggle sidebar" aria-expanded={!collapsed} onPress={() => setCollapsed(!collapsed)}>
                <PanelLeft aria-hidden="true" />
              </Button>
              <Tooltip.Content>{collapsed ? "Expand sidebar" : "Collapse sidebar"}</Tooltip.Content>
            </Tooltip>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">BrowserSilo</p>
              <p className="hidden truncate text-xs text-muted sm:block">Private browser infrastructure</p>
            </div>
            <div className="flex-1" />
            <Button ref={searchRef} aria-label="Search" aria-haspopup="dialog" variant="ghost" onPress={openSearch}>
              <Search aria-hidden="true" />
              <span className="hidden sm:inline">Search</span>
              <Kbd className="hidden md:flex"><Kbd.Abbr keyValue="command" /><Kbd.Content>K</Kbd.Content></Kbd>
            </Button>
            <Tooltip>
              <Button isIconOnly aria-label={themeLabel} variant="ghost" onPress={() => setTheme(theme === "dark" ? "light" : "dark")}>
                {theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
              </Button>
              <Tooltip.Content>{themeLabel}</Tooltip.Content>
            </Tooltip>
          </header>
          <main id="bs-main" className="bs-main" ref={mainRef} tabIndex={-1}>{children}</main>
        </div>
      </div>

      <Modal.Backdrop isOpen={mobileOpen} onOpenChange={setMobileOpen}>
        <Modal.Container className="bs-mobile-container" placement="center">
          <Modal.Dialog className="bs-mobile-dialog" aria-label="Navigation">
            <div className="bs-sidebar-brand">
              {brand}
              <Tooltip>
                <Button autoFocus isIconOnly aria-label="Close navigation" variant="ghost" onPress={() => setMobileOpen(false)}><X aria-hidden="true" /></Button>
                <Tooltip.Content>Close navigation</Tooltip.Content>
              </Tooltip>
            </div>
            {links(true)}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <Modal.Backdrop isOpen={commandOpen} onOpenChange={setCommandOpen}>
        <Modal.Container size="lg" placement="top">
          <Modal.Dialog className="bs-command-dialog" aria-label="Search BrowserSilo">
            <Command className="bs-command" label="Search resources and pages" loop>
              <div className="bs-command-input-row">
                <Search aria-hidden="true" />
                <Command.Input ref={commandInputRef} autoFocus value={searchQuery} onValueChange={setSearchQuery} placeholder="Search resources and pages" />
                {searchQuery && (
                  <Tooltip>
                    <Button isIconOnly size="sm" variant="ghost" aria-label="Clear search" onPress={() => { setSearchQuery(""); commandInputRef.current?.focus(); }}><Delete aria-hidden="true" /></Button>
                    <Tooltip.Content>Clear search</Tooltip.Content>
                  </Tooltip>
                )}
                <Tooltip>
                  <Button isIconOnly size="sm" variant="ghost" aria-label="Close search" onPress={() => setCommandOpen(false)}><X aria-hidden="true" /></Button>
                  <Tooltip.Content>Close search</Tooltip.Content>
                </Tooltip>
              </div>
              <Command.List aria-label="BrowserSilo pages">
                <Command.Empty>No pages found.</Command.Empty>
                <Command.Group heading="Navigate">
                  {navigation.map((item) => (
                    <Command.Item key={item.to} value={item.label} keywords={[item.to]} onSelect={() => { navigate(item.to); setCommandOpen(false); }}>
                      <item.icon aria-hidden="true" /><span>{item.label}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              </Command.List>
              <div className="bs-command-footer">
                <span><Kbd><Kbd.Content>↑↓</Kbd.Content></Kbd> Navigate</span>
                <span><Kbd><Kbd.Content>Enter</Kbd.Content></Kbd> Open</span>
                <span><Kbd><Kbd.Content>Esc</Kbd.Content></Kbd> Close</span>
              </div>
            </Command>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}

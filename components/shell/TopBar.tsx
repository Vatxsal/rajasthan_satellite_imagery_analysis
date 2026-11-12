"use client";

import { useEffect } from "react";
import { FileImage, FileSpreadsheet, Loader2, LogIn, LogOut, PanelLeft, Moon, Sun } from "lucide-react";
import { isDemoData } from "@/lib/data";
import { togglePanelSheet } from "@/lib/sheets";
import { useActiveScene, useActiveSelection, useAppStore } from "@/store/useAppStore";
import { useSession } from "@/store/useSession";
import { useTheme } from "@/store/useTheme";
import Button from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/Menu";
import Tooltip from "@/components/ui/Tooltip";

function Breadcrumb() {
  const districtSel = useAppStore((s) => s.districtSel);
  const tehsilSel = useAppStore((s) => s.tehsilSel);
  const ilrSel = useAppStore((s) => s.ilrSel);
  const setDistrict = useAppStore((s) => s.setDistrict);
  const setTehsil = useAppStore((s) => s.setTehsil);
  const setIlr = useAppStore((s) => s.setIlr);

  const crumbs: { key: string; label: string; onClick?: () => void }[] = [
    {
      key: "state",
      label: "Rajasthan",
      onClick: districtSel ? () => setDistrict(null) : undefined,
    },
  ];
  if (districtSel) {
    crumbs.push({
      key: districtSel.id,
      label: districtSel.name,
      onClick: tehsilSel ? () => setTehsil(null) : undefined,
    });
  }
  if (tehsilSel) {
    crumbs.push({
      key: tehsilSel.id,
      label: tehsilSel.name,
      onClick: ilrSel ? () => setIlr(null) : undefined,
    });
  }
  if (ilrSel) {
    crumbs.push({ key: ilrSel.id, label: ilrSel.name });
  }

  return (
    <nav aria-label="Selection path" className="flex min-w-0 items-center gap-1 text-sm">
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        return (
          <span key={crumb.key} className="flex min-w-0 items-center gap-1">
            {index > 0 && <span aria-hidden className="text-muted">›</span>}
            {crumb.onClick && !isLast ? (
              <button
                type="button"
                onClick={crumb.onClick}
                className="max-w-[10rem] truncate rounded-sm px-1 text-muted transition-colors duration-150 hover:text-text"
              >
                {crumb.label}
              </button>
            ) : (
              <span
                className={`max-w-[10rem] truncate px-1 ${isLast ? "font-medium text-text" : "text-muted"}`}
              >
                {crumb.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function ThemeToggle() {
  const theme = useTheme((s) => s.theme);
  const toggleTheme = useTheme((s) => s.toggleTheme);

  return (
    <Tooltip content={theme === "light" ? "Switch to dark theme" : "Switch to light theme"} side="bottom">
      <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="Toggle theme">
        {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
      </Button>
    </Tooltip>
  );
}

function UserMenu() {
  const activeScene = useActiveScene();
  const selection = useActiveSelection();
  const downloadBusy = useAppStore((s) => s.downloadBusy);
  const requestDownload = useAppStore((s) => s.requestDownload);
  const status = useSession((s) => s.status);
  const role = useSession((s) => s.role);
  const name = useSession((s) => s.name);
  const fetchSession = useSession((s) => s.fetchSession);
  const signOut = useSession((s) => s.signOut);

  useEffect(() => {
    if (status === "unknown") void fetchSession();
  }, [status, fetchSession]);

  const handleDownload = (format: "png" | "tiff") => {
    if (!activeScene || !selection || downloadBusy) return;
    requestDownload(
      activeScene,
      { name: selection.name, geometry: selection.geometry, bbox: selection.bbox },
      format,
    );
  };

  const displayName =
    status === "signed-in"
      ? name ?? (role === "guest" ? "Guest" : "User")
      : status === "signed-out"
        ? "Sign in"
        : "…";
  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
  const badge = role === "sso" ? "SSO" : role === "guest" ? "Guest" : null;

  // The trigger shows initials, the display name and (≥640px) a badge. The
  // accessible name must contain every visible fragment verbatim or
  // Lighthouse's label-content-name-mismatch fires (e.g. visible "SI" vs a
  // bare "Sign in" label), so compose it from exactly what is rendered.
  const visibleLabel = [
    ...new Set([
      initials || "…",
      displayName,
      ...(badge ? [badge] : []),
      ...(status === "unknown" ? ["checking session"] : []),
    ]),
  ].join(" ");

  const goSignIn = () => {
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.assign(next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`);
  };

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={status === "signed-in" ? `Account: ${visibleLabel}` : visibleLabel}
          className="flex h-8 items-center gap-2 rounded border border-border bg-surface px-1.5 transition-colors duration-150 hover:bg-surface-2"
        >
          <span className="grid h-5 w-5 place-items-center rounded-sm bg-accent-soft text-[11px] font-semibold text-accent">
            {initials || "…"}
          </span>
          <span className="hidden max-w-[9rem] truncate text-sm text-text sm:block">
            {displayName}
          </span>
          {badge && (
            <span
              className={`hidden rounded-sm px-1 py-px text-[10px] font-semibold uppercase tracking-wide sm:inline ${
                badge === "SSO"
                  ? "bg-accent text-accent-fg"
                  : "border border-border bg-surface-2 text-muted"
              }`}
            >
              {badge}
            </span>
          )}
        </button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuLabel>
          {status === "signed-in"
            ? `${displayName} · ${badge ?? "session"}`
            : status === "signed-out"
              ? "Not signed in"
              : "Checking session…"}
        </MenuLabel>
        <MenuSeparator />
        <MenuItem>Profile</MenuItem>
        <MenuItem>Preferences</MenuItem>
        <MenuSeparator />
        <MenuLabel>
          {activeScene ? `Download ${activeScene.date}` : "Download active scene"}
        </MenuLabel>
        <MenuItem
          disabled={!activeScene || !selection || downloadBusy !== null}
          onSelect={() => handleDownload("png")}
        >
          {downloadBusy === "png" ? <Loader2 size={14} className="animate-spin" /> : <FileImage size={14} />}
          {downloadBusy === "png" ? "Preparing…" : "PNG (visual)"}
        </MenuItem>
        <MenuItem
          disabled={!activeScene || !selection || downloadBusy !== null}
          onSelect={() => handleDownload("tiff")}
        >
          {downloadBusy === "tiff" ? <Loader2 size={14} className="animate-spin" /> : <FileSpreadsheet size={14} />}
          {downloadBusy === "tiff" ? "Preparing…" : "GeoTIFF (10 m)"}
        </MenuItem>
        <MenuSeparator />
        {role === "guest" && (
          <MenuItem onSelect={goSignIn}>
            <LogIn size={14} />
            Sign in with SSO
          </MenuItem>
        )}
        {status === "signed-in" ? (
          <MenuItem onSelect={() => void signOut()}>
            <LogOut size={14} />
            Sign out
          </MenuItem>
        ) : (
          <MenuItem onSelect={goSignIn}>
            <LogIn size={14} />
            Sign in
          </MenuItem>
        )}
      </MenuContent>
    </Menu>
  );
}

function DataChip() {
  return isDemoData ? (
    <Chip className="hidden text-[11px] sm:inline-flex" aria-label="Demo data">
      Demo data
    </Chip>
  ) : (
    <Chip tone="success" className="hidden text-[11px] sm:inline-flex" aria-label="Live Copernicus data">
      Live data
    </Chip>
  );
}

export default function TopBar() {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const selection = useActiveSelection();

  return (
    <header className="relative z-40 flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={togglePanelSheet}
        aria-label={sidebarOpen ? "Close panel" : "Open panel"}
        aria-expanded={sidebarOpen}
      >
        <PanelLeft size={16} />
      </Button>

      {/* Phone/tablet: breadcrumb when an area is selected, else the short title. */}
      <div className="flex min-w-0 flex-1 items-center gap-2 lg:hidden">
        {selection ? (
          <Breadcrumb />
        ) : (
          <h1 className="truncate text-base font-semibold tracking-tight text-text">
            Rajasthan Explorer
          </h1>
        )}
        <DataChip />
      </div>

      {/* Desktop: full wordmark left, selection path centered. */}
      <div className="hidden min-w-0 items-center gap-2 lg:flex">
        <h1 className="truncate text-base font-semibold tracking-tight text-text">
          Rajasthan Imagery Explorer
        </h1>
        <DataChip />
      </div>

      <div className="pointer-events-none mx-auto hidden min-w-0 px-4 lg:block">
        <div className="pointer-events-auto">
          <Breadcrumb />
        </div>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}

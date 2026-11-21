import { useEffect, useId, useRef, useState } from 'react';
import {
  Activity,
  CircleUser,
  Files,
  Monitor,
  Terminal,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { EditorPreferences } from '../../store/useEditorPreferences';
import { EditorAccountMenuItems } from './EditorAccountMenuItems';

export type WorkspaceView = EditorPreferences['sidebarView'];

const activities = [
  { id: 'explorer', label: 'Explorer', Icon: Files },
] as const;

const tools = [
  { id: 'terminal', label: 'Terminal', Icon: Terminal },
  { id: 'scope', label: 'Scope', Icon: Activity },
  { id: 'serial', label: 'Serial Monitor', Icon: Monitor },
] as const;

export type WorkspaceTool = (typeof tools)[number]['id'];

export function WorkspaceToolButton({ tool, pressed, onToggle, compact = false }: {
  tool: WorkspaceTool;
  pressed: boolean;
  onToggle: (tool: WorkspaceTool) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const { label, Icon } = tools.find(({ id }) => id === tool)!;
  const name = t(`editor.activity.${tool}`, label);
  return (
    <button type="button" className={compact ? 'workspace-status-tool' : 'workspace-activity-button'}
      title={name} aria-label={name} aria-pressed={pressed} onClick={() => onToggle(tool)}>
      <Icon size={compact ? 14 : 18} aria-hidden />
    </button>
  );
}

function WorkspaceAccount() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const account = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const label = t('editor.menu.account', 'Account');

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !account.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  const closeAccount = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div
      className="workspace-activity-account"
      ref={account}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === 'Escape') {
          event.stopPropagation();
          closeAccount();
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        const items = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            '.workspace-account-menu button:not(:disabled), .workspace-account-menu a[href]',
          ),
        );
        if (items.length === 0) return;
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next =
          event.key === 'ArrowDown' ? index + 1 : index < 0 ? items.length - 1 : index - 1;
        event.preventDefault();
        items[(next + items.length) % items.length]?.focus();
      }}
    >
      <button
        type="button"
        className="workspace-activity-button"
        ref={trigger}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
      >
        <CircleUser size={18} aria-hidden />
      </button>
      {open && (
        <div className="emb-menu workspace-account-menu dropdown-panel" id={menuId} role="menu" aria-label={label}>
          <EditorAccountMenuItems onClose={closeAccount} />
        </div>
      )}
    </div>
  );
}

export function WorkspaceActivityBar({
  view,
  openTools,
  onSelect,
  onToggleTool,
  flashBoardName,
}: {
  view: WorkspaceView | null;
  openTools: Record<WorkspaceTool, boolean>;
  onSelect: (view: WorkspaceView) => void;
  onToggleTool: (tool: WorkspaceTool) => void;
  flashBoardName?: string;
}) {
  const { t } = useTranslation();
  const flashLabel = flashBoardName
    ? t('editor.flash.selectedBoard', 'Flash · {{board}}', { board: flashBoardName })
    : t('editor.toolbar.flash.label', 'Flash');
  return (
    <nav
      className="workspace-activity-bar"
      aria-label={t('editor.activity.label', 'Workspace views')}
    >
      {activities.map(({ id, label, Icon }) => (
        <button
          type="button"
          className="workspace-activity-button"
          key={id}
          title={t(`editor.activity.${id}`, label)}
          aria-label={t(`editor.activity.${id}`, label)}
          aria-pressed={view === id}
          onClick={() => onSelect(id)}
        >
          <Icon size={18} aria-hidden />
        </button>
      ))}
      <div
        className="workspace-activity-panel-tools"
        role="group"
        aria-label={t('editor.activity.tools', 'Workspace tools')}
      >
        {tools.map(({ id }) => (
          <WorkspaceToolButton key={id} tool={id} pressed={openTools[id]} onToggle={onToggleTool} />
        ))}
      </div>
      <div className="workspace-activity-panel-tools">
        <button type="button" className="workspace-activity-button workspace-activity-flash"
          title={flashLabel} aria-label={flashLabel} aria-pressed={view === 'flash'}
          onClick={() => onSelect('flash')}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <path d="M12 8v7" />
            <path d="m9 12 3 3 3-3" />
            <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
          </svg>
          {flashBoardName && <span className="workspace-activity-flash-dot" aria-hidden />}
        </button>
      </div>
      <div
        className="workspace-activity-account-tools"
        role="group"
        aria-label={t('editor.activity.accountTools', 'Account and settings')}
      >
        <WorkspaceAccount />
      </div>
    </nav>
  );
}

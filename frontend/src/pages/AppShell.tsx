import { useState, type ReactNode } from 'react';

import ChangePasswordGate from '../components/ChangePasswordGate';
import ConversationList from '../components/ConversationList';
import ConversationView from '../components/ConversationView';
import EmptyState from '../components/EmptyState';
import { useAuth } from '../auth/AuthContext';
import { getInitials } from '../lib/format';
import { hasPermission, PERMISSIONS } from '../lib/permissions';
import AccountsPage from './AccountsPage';
import AiKnowledgePage from './AiKnowledgePage';
import LeadSourcesPage from './LeadSourcesPage';
import SettingsPage from './SettingsPage';
import StagesPage from './StagesPage';
import TagsPage from './TagsPage';
import TeamPage from './TeamPage';
import TemplatesPage from './TemplatesPage';

type AppView =
  | 'inbox'
  | 'accounts'
  | 'team'
  | 'stages'
  | 'tags'
  | 'ai-knowledge'
  | 'templates'
  | 'lead-sources'
  | 'settings';

type AuthUser = {
  id: string;
  name: string;
  mustChangePassword?: boolean;
};

type AuthOrganization = {
  id: string;
  name: string;
};

type AuthValue = {
  user: AuthUser | null;
  organization: AuthOrganization | null;
  logout: () => void | Promise<void>;
  permissions: string[];
};

type NavButtonProps = {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
};

/**
 * Nav reads as a strip of labelled channels rather than a row of buttons: letterspaced caps, and
 * the active one lit by the key light from underneath. The underline is the indicator - a filled
 * pill would compete with the primary action.
 */
const NavButton = ({ active, onClick, children }: NavButtonProps) => (
  <button
    type="button"
    onClick={onClick}
    aria-current={active}
    className={`relative shrink-0 whitespace-nowrap px-3 py-2 text-[0.6875rem] font-semibold uppercase tracking-[0.14em] transition-colors ${
      active ? 'text-key' : 'text-muted hover:text-bone'
    }`}
  >
    {children}
    <span
      aria-hidden="true"
      className={`absolute inset-x-2 -bottom-px h-px transition-opacity ${
        active ? 'bg-key opacity-100 shadow-[0_0_10px_1px_rgb(255_158_74/60%)]' : 'opacity-0'
      }`}
    />
  </button>
);

const AppShell = () => {
  const { user, organization, logout, permissions } = useAuth() as AuthValue;
  const [view, setView] = useState<AppView>('inbox');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Bumped to force the inbox list to remount and refetch after a delete removes a row from it.
  const [listRefreshKey, setListRefreshKey] = useState(0);
  const canReadAccounts = hasPermission(permissions, PERMISSIONS.ACCOUNTS_READ);
  const canReadUsers = hasPermission(permissions, PERMISSIONS.USERS_READ);
  const canManageStages = hasPermission(permissions, PERMISSIONS.CRM_STAGE_MANAGE);
  const canManageTags = hasPermission(permissions, PERMISSIONS.CRM_TAGS_MANAGE);
  const canManageAiKnowledge = hasPermission(permissions, PERMISSIONS.AI_KNOWLEDGE_MANAGE);
  const canManageTemplates = hasPermission(permissions, PERMISSIONS.TEMPLATES_MANAGE);
  const canManageLeadSources = hasPermission(permissions, PERMISSIONS.LEAD_SOURCES_MANAGE);
  const canManageSettings = hasPermission(permissions, PERMISSIONS.SETTINGS_MANAGE);

  // A temporary password must be replaced before anything else is reachable. The backend
  // enforces this too, so this is UX rather than the security boundary.
  if (user?.mustChangePassword) {
    return <ChangePasswordGate />;
  }

  return (
    <div className="flex h-screen flex-col bg-ink">
      {/* Wraps rather than overflows: eight channels need ~1030px of strip, so below lg the nav
          takes a line of its own (order-3, w-full) and scrolls sideways within it, while the
          wordmark and the account controls share the line above. Sharing one line instead would
          squeeze the nav to a couple of dozen pixels - scrollable, but with no legible label in
          view. From lg it sits back between them on a single line. */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline bg-ink-2/80 px-4 py-2.5 backdrop-blur sm:px-5">
        <span className="wordmark order-1 shrink-0">Vistaar</span>
        {organization?.name ? (
          <span className="order-1 hidden shrink-0 border-l border-hairline pl-5 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted xl:inline">
            {organization.name}
          </span>
        ) : null}
        <nav
          aria-label="Sections"
          className="no-scrollbar order-3 -mx-1 flex w-full min-w-0 items-center gap-0.5 overflow-x-auto px-1 lg:order-2 lg:w-auto lg:flex-1"
        >
          <NavButton active={view === 'inbox'} onClick={() => setView('inbox')}>
            Inbox
          </NavButton>
          {canReadAccounts ? (
            <NavButton active={view === 'accounts'} onClick={() => setView('accounts')}>
              Accounts
            </NavButton>
          ) : null}
          {canReadUsers ? (
            <NavButton active={view === 'team'} onClick={() => setView('team')}>
              Team
            </NavButton>
          ) : null}
          {canManageStages ? (
            <NavButton active={view === 'stages'} onClick={() => setView('stages')}>
              Stages
            </NavButton>
          ) : null}
          {canManageTags ? (
            <NavButton active={view === 'tags'} onClick={() => setView('tags')}>
              Tags
            </NavButton>
          ) : null}
          {canManageLeadSources ? (
            <NavButton active={view === 'lead-sources'} onClick={() => setView('lead-sources')}>
              Lead sources
            </NavButton>
          ) : null}
          {canManageAiKnowledge ? (
            <NavButton active={view === 'ai-knowledge'} onClick={() => setView('ai-knowledge')}>
              Knowledge
            </NavButton>
          ) : null}
          {canManageTemplates ? (
            <NavButton active={view === 'templates'} onClick={() => setView('templates')}>
              Templates
            </NavButton>
          ) : null}
          {canManageSettings ? (
            <NavButton active={view === 'settings'} onClick={() => setView('settings')}>
              Settings
            </NavButton>
          ) : null}
        </nav>
        <div className="order-2 ml-auto flex shrink-0 items-center gap-3 lg:order-3">
          <a
            href="whatsapp-admin://open"
            className="rounded-md border border-hairline px-2.5 py-1.5 font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-bone-dim transition-colors hover:border-key/40 hover:text-key"
          >
            W-Staff
          </a>
          <div className="flex items-center gap-2 border-l border-hairline pl-3">
            {/* The initials sit in the key light: the one warm point in the masthead, so "who am
                I signed in as" is answerable at a glance without reading. */}
            <span className="flex h-7 w-7 items-center justify-center rounded-full border border-key/40 bg-key/10 font-mono text-[0.625rem] font-semibold text-key-soft">
              {getInitials(user?.name)}
            </span>
            <span className="hidden text-sm text-bone-dim md:inline">{user?.name}</span>
          </div>
          <button
            type="button"
            onClick={logout}
            className="font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted transition-colors hover:text-danger"
          >
            Sign out
          </button>
        </div>
      </header>

      {view === 'accounts' && canReadAccounts ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <AccountsPage />
        </div>
      ) : view === 'team' && canReadUsers ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TeamPage />
        </div>
      ) : view === 'stages' && canManageStages ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <StagesPage />
        </div>
      ) : view === 'tags' && canManageTags ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TagsPage />
        </div>
      ) : view === 'ai-knowledge' && canManageAiKnowledge ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <AiKnowledgePage />
        </div>
      ) : view === 'templates' && canManageTemplates ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TemplatesPage />
        </div>
      ) : view === 'lead-sources' && canManageLeadSources ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <LeadSourcesPage />
        </div>
      ) : view === 'settings' && canManageSettings ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SettingsPage />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Below lg the inbox is a drill-down, not three columns: list, then thread, then
              details. Side by side it gave the thread 18px at laptop widths. From lg the list
              becomes a fixed rail and both panes are visible at once again. */}
          <div
            className={`min-h-0 w-full lg:block lg:w-[21rem] lg:shrink-0 xl:w-[23rem] ${
              selectedId ? 'hidden' : 'block'
            }`}
          >
            <ConversationList
              key={`list-${listRefreshKey}`}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </div>
          {selectedId ? (
            <ConversationView
              key={selectedId}
              conversationId={selectedId}
              onBack={() => setSelectedId(null)}
              onDeleted={() => {
                // Clear the selection first: the backend now 404s this id, so leaving it selected
                // would swap the thread for an error message. Then force the list to refetch, or
                // the deleted row sits there until the next poll.
                setSelectedId(null);
                setListRefreshKey((value) => value + 1);
              }}
            />
          ) : (
            /* Hidden on small: with no thread open the list already fills the screen, and an
               empty "select a conversation" panel below it would just be dead space. */
            <div className="hidden flex-1 lg:block">
              <EmptyState
                title="Select a conversation"
                description="Choose a conversation from the list to view its thread."
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default AppShell;

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

type AppView =
  | 'inbox'
  | 'accounts'
  | 'team'
  | 'stages'
  | 'tags'
  | 'ai-knowledge'
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
    className={`relative px-3 py-2 text-[0.6875rem] font-semibold uppercase tracking-[0.14em] transition-colors ${
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
  const canReadAccounts = hasPermission(permissions, PERMISSIONS.ACCOUNTS_READ);
  const canReadUsers = hasPermission(permissions, PERMISSIONS.USERS_READ);
  const canManageStages = hasPermission(permissions, PERMISSIONS.CRM_STAGE_MANAGE);
  const canManageTags = hasPermission(permissions, PERMISSIONS.CRM_TAGS_MANAGE);
  const canManageAiKnowledge = hasPermission(permissions, PERMISSIONS.AI_KNOWLEDGE_MANAGE);
  const canManageLeadSources = hasPermission(permissions, PERMISSIONS.LEAD_SOURCES_MANAGE);
  const canManageSettings = hasPermission(permissions, PERMISSIONS.SETTINGS_MANAGE);

  // A temporary password must be replaced before anything else is reachable. The backend
  // enforces this too, so this is UX rather than the security boundary.
  if (user?.mustChangePassword) {
    return <ChangePasswordGate />;
  }

  return (
    <div className="flex h-screen flex-col bg-ink">
      <header className="flex items-center justify-between border-b border-hairline bg-ink-2/80 px-5 py-2.5 backdrop-blur">
        <div className="flex items-center gap-5">
          <span className="wordmark">Vistaar</span>
          {organization?.name ? (
            <span className="hidden border-l border-hairline pl-5 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted sm:inline">
              {organization.name}
            </span>
          ) : null}
          <nav className="flex items-center gap-0.5">
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
            {canManageSettings ? (
              <NavButton active={view === 'settings'} onClick={() => setView('settings')}>
                Settings
              </NavButton>
            ) : null}
          </nav>
        </div>
        <div className="flex items-center gap-3">
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
          <ConversationList selectedId={selectedId} onSelect={setSelectedId} />
          {selectedId ? (
            <ConversationView key={selectedId} conversationId={selectedId} />
          ) : (
            <div className="flex-1">
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

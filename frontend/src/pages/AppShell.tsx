import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import ChangePasswordDialog from '../components/ChangePasswordDialog';
import { useIsMobileViewport, useMobileBackLayer } from '../hooks/useMobileBackLayer';
import { useReminderAlarms } from '../hooks/useReminderAlarms';
import { usePushRegistration } from '../hooks/usePushRegistration';
import ChangePasswordGate from '../components/ChangePasswordGate';
import { type AiResponseStatus, type EnquiryClass } from '../types/analytics';
import AnalyticsPage from './AnalyticsPage';
import ConversationList from '../components/ConversationList';
import ConversationView from '../components/ConversationView';
import EmptyState from '../components/EmptyState';
import ReminderDetailDialog from '../components/reminders/ReminderDetailDialog';
import MobileSectionMenu, { type MobileNavItem } from '../components/MobileSectionMenu';
import MobileAppBar from '../components/mobile/MobileAppBar';
import MobileBottomNav from '../components/mobile/MobileBottomNav';
import { useAuth } from '../auth/AuthContext';
import { getInitials } from '../lib/format';
import { onDeepLinkOpened } from '../lib/capacitor-deep-link';
import { clearDeepLinkTarget, readDeepLinkTarget } from '../lib/deep-link';
import { readMetaConnectReturn } from '../lib/meta-connect';
import { hasPermission, PERMISSIONS } from '../lib/permissions';
import AccountsPage from './AccountsPage';
import AiKnowledgePage from './AiKnowledgePage';
import LeadSourcesPage from './LeadSourcesPage';
import SettingsPage from './SettingsPage';
import StagesPage from './StagesPage';
import TagsPage from './TagsPage';
import TasksPage from './TasksPage';
import TeamPage from './TeamPage';

type AppView =
  | 'inbox'
  | 'tasks'
  | 'analytics'
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
  // Needed by the reminder-alarm sync, which is mounted here. Same two values the rest of the
  // app reads off the context; this local type just had not needed them before.
  authedRequest: <T>(makeRequest: (token: string | null) => Promise<T>) => Promise<T>;
  isAuthenticated: boolean;
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
    // px-2 below sm only: at 320px the wordmark, the two live sections and the menu button are
    // about 11px too wide at px-3 and the menu wrapped onto a second row, costing 37px of
    // height on the smallest screen that can least afford it. From sm - and so on every
    // desktop - the padding is exactly what it was.
    className={`relative shrink-0 whitespace-nowrap px-2 py-2 text-[0.6875rem] font-semibold uppercase tracking-[0.14em] transition-colors sm:px-3 ${
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

/**
 * One section screen: its bar, its scroll area, and room for the bottom nav.
 *
 * Defined at module level rather than inside AppShell on purpose - a component declared during
 * render gets a new identity every render, and React would unmount and remount the whole page
 * inside it each time, throwing away its fetched state and scroll position.
 *
 * `isTab` marks the destinations the bottom bar owns. Those are roots: they get no back
 * control, because back from a root is how you leave the app on Android and a chevron that
 * pretends otherwise is a lie. Everything reached through More is a pushed screen and gets one.
 */
const SectionScreen = ({
  mobile,
  title,
  isTab = false,
  onBack,
  children,
}: {
  mobile: boolean;
  title: string;
  isTab?: boolean;
  onBack: () => void;
  children: ReactNode;
}) => (
  <>
    {mobile ? (
      <MobileAppBar title={title} onBack={isTab ? undefined : onBack} backLabel="Back to inbox" />
    ) : null}
    {/* m-nav-clearance keeps the last row clear of the fixed bottom bar. Applied to the
        scroller rather than the page so the bar overlaps nothing. */}
    <div
      className={`min-h-0 flex-1 overflow-y-auto ${mobile ? 'm-nav-clearance m-has-appbar' : ''}`}
    >
      {children}
    </div>
  </>
);

const AppShell = () => {
  const { user, organization, logout, permissions, authedRequest, isAuthenticated } =
    useAuth() as AuthValue;
  // Facebook's callback redirects the browser to `/`, which reloads the whole app at the inbox.
  // Landing there after signing in would strand the person two clicks from what they were doing,
  // so the return trip opens on Lead sources, where the wizard is waiting.
  /**
   * The lead a WhatsApp notification link asked for, read once on mount.
   *
   * Read HERE rather than in App, because this component only renders for a signed-in user -
   * App shows LoginPage otherwise. Signing in unmounts LoginPage and mounts this fresh, so the
   * initialisers below run with the parameter still in the URL, and the link lands on the right
   * thread after login without anything having to remember it across the sign-in.
   */
  const deepLink = useMemo(() => readDeepLinkTarget(), []);

  const [view, setView] = useState<AppView>(() => {
    // An explicit lead link wins over the Meta return: it names one record, which is a stronger
    // instruction than "you just came back from Facebook".
    if (deepLink) {
      return 'inbox';
    }

    return readMetaConnectReturn() ? 'lead-sources' : 'inbox';
  });
  const [selectedId, setSelectedId] = useState<string | null>(
    () => deepLink?.conversationId ?? null,
  );
  /**
   * The reminder a `View reminder:` link named, if it named one.
   *
   * Held as a pair rather than as a bare id because the lookup is scoped by the conversation -
   * see ReminderDetailDialog - and because the owner can navigate away while this is open,
   * at which point the dialog should close rather than hang over an unrelated thread.
   */
  const [openReminder, setOpenReminder] = useState<{
    reminderId: string;
    conversationId: string;
  } | null>(() =>
    deepLink?.reminderId
      ? { reminderId: deepLink.reminderId, conversationId: deepLink.conversationId }
      : null,
  );
  // Bumped to force the inbox list to remount and refetch after a delete removes a row from it.
  const [listRefreshKey, setListRefreshKey] = useState(0);
  /**
   * Bumped when a reminder changes OUTSIDE the lead panel - which today means from the dialog
   * above. Without it, completing a reminder from a notification leaves the panel behind it
   * still listing that reminder as open, which is a stale screen rather than a wrong one, but
   * is exactly the kind of staleness that gets reported as "it did not work".
   */
  const [remindersRefreshKey, setRemindersRefreshKey] = useState(0);
  const [changingPassword, setChangingPassword] = useState(false);
  /** The More sheet. Owned here rather than inside the bar so the sheet outlives a tab change. */
  const [moreOpen, setMoreOpen] = useState(false);
  // Decides which chrome renders - the desktop masthead, or the phone's app bar plus bottom
  // navigation. Reports desktop wherever `matchMedia` is unavailable, so the server, a
  // snapshot and every existing test keep the layout they already had.
  const isMobileViewport = useIsMobileViewport();
  /**
   * Which section a thread was opened FROM, when it was not the inbox.
   *
   * A reminder opens a lead, and the thread can only render inside the inbox branch - so `view`
   * has to become 'inbox' on the way. Without remembering where the tap came from, closing the
   * thread would strand the owner in the inbox rather than back in the reminders list they were
   * working through. A ref because nothing renders from it, and because `openConversation` has
   * to stay referentially stable: it is a dependency of the alarm sync, which would otherwise
   * tear down and re-register its listeners on every navigation.
   */
  const conversationOriginRef = useRef<AppView | null>(null);
  const viewRef = useRef(view);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  /**
   * Wipes the link parameters once they have been acted on.
   *
   * Without this a refresh would drag the owner back to the thread they had just navigated away
   * from, and the URL would keep carrying a lead id into anything it was pasted into. The state
   * above has already consumed the value, so clearing the address bar changes nothing on screen.
   */
  useEffect(() => {
    if (deepLink) {
      clearDeepLinkTarget();
    }
  }, [deepLink]);

  /**
   * A reminder dialog belongs to ONE thread. Leaving the lead closes it.
   *
   * Without this, dismissing the thread would leave the dialog's state set, and coming back to
   * the same lead later would resurrect a reminder popup the owner had already walked away
   * from - which reads as the app re-notifying them about something they dealt with.
   */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpenReminder((current) =>
      current && current.conversationId === selectedId ? current : null,
    );
  }, [selectedId]);

  /**
   * Opens a lead. Used by the reminders list and by a tapped notification, so both land in the
   * same place as clicking the thread in the inbox - no second navigation concept.
   */
  const openConversation = useCallback((conversationId: string) => {
    conversationOriginRef.current = viewRef.current === 'inbox' ? null : viewRef.current;
    setView('inbox');
    setSelectedId(conversationId);
  }, []);

  /**
   * THE ANDROID HALF OF THE SAME LINK.
   *
   * In a browser the parameters are in the address bar and `deepLink` above already has them.
   * In the APK the WebView is never navigated to the link's URL - it is served from
   * `https://localhost` - so Android hands the URL over as an intent instead, and this is where
   * it lands. Same destination, same two ids, arriving through a different door.
   *
   * Subscribed HERE rather than in main.tsx because this component is the only thing that knows
   * how to open a lead, and it only exists once there is a signed-in user. A link that arrived
   * during the splash screen or before sign-in is buffered until this runs.
   */
  useEffect(
    () =>
      onDeepLinkOpened(({ conversationId, reminderId }) => {
        openConversation(conversationId);
        setOpenReminder(reminderId ? { reminderId, conversationId } : null);
      }),
    [openConversation],
  );

  /** Opening a thread from the inbox list itself has no origin to return to beyond the list. */
  const selectConversation = useCallback((conversationId: string) => {
    conversationOriginRef.current = null;
    setSelectedId(conversationId);
  }, []);

  /**
   * Returns to the INBOX ROOT - the list, not whatever thread happened to still be selected.
   *
   * Wired only to phone chrome (the bottom bar's Inbox tab and every pushed section's back
   * arrow), so this cannot change desktop, where the masthead still calls `setView('inbox')`
   * exactly as it always did.
   *
   * Clearing the selection is what makes the tab honest. Leaving it set landed you on an open
   * thread with the Inbox tab lit - and because the bar hides itself over a thread, the
   * navigation you had just used would vanish, which is a dead end rather than a destination.
   */
  const goToInbox = useCallback(() => {
    conversationOriginRef.current = null;
    setSelectedId(null);
    setView('inbox');
  }, []);

  /**
   * The open thread was deleted. Clears the selection WITHOUT the origin restore that
   * `closeConversation` performs.
   *
   * Deliberately not `closeConversation`: that was wired here briefly and changed desktop
   * behaviour, because a lead opened from Reminders carries an origin, and deleting it then
   * threw the owner back to the reminders list instead of leaving them in the inbox - on
   * desktop as well as on a phone. The thread no longer exists, so there is nothing to
   * navigate "back" to; the original behaviour was to drop the selection and stay put.
   */
  const dismissDeletedConversation = useCallback(() => {
    conversationOriginRef.current = null;
    setSelectedId(null);
  }, []);

  /** The one way a thread closes, so the in-app arrow and the back gesture cannot diverge. */
  const closeConversation = useCallback(() => {
    setSelectedId(null);

    if (conversationOriginRef.current) {
      setView(conversationOriginRef.current);
      conversationOriginRef.current = null;
    }
  }, []);

  /**
   * THE THREE MOBILE LAYERS, outermost first. Registration order is what the back gesture
   * walks, so they are declared in the order they stack on screen rather than grouped by
   * concern: a section opened over the inbox closes before the thread underneath it does.
   *
   * All three are no-ops on a desktop viewport - see useMobileBackLayer - so none of this
   * changes how the dashboard behaves on a laptop.
   */
  useMobileBackLayer({
    // Any section other than the inbox is a screen the person navigated INTO, so back returns
    // to the inbox rather than leaving the app. The inbox itself is the root: back from there
    // exits, which is what Android expects.
    active: view !== 'inbox',
    onBack: useCallback(() => setView('inbox'), []),
  });

  useMobileBackLayer({
    // An open thread. Back returns to the list, which has stayed mounted the whole time, so its
    // filters and scroll position are still where they were.
    active: selectedId !== null,
    onBack: closeConversation,
  });

  // No layer for the password dialog here: ChangePasswordDialog registers its own, the way
  // every other modal in the app now does. Two layers for one dialog would need two back
  // presses to dismiss it.

  /**
   * MOUNTED ONCE, HERE. AppShell renders only when authenticated and only once per session, so
   * this is the one place a device-wide concern belongs - putting it in the reminders page
   * would stop syncing the moment the owner navigated away, and putting it in a list row would
   * start a sync per row.
   *
   * `enabled` is tied to the auth state so a logout stops it and a different account starts
   * clean: the effects tear down their listeners and nothing syncs for the previous user.
   */
  const {
    status: alarmStatus,
    requestPermission: requestNotificationPermission,
    requestExactAlarm,
    requestClockAlarmBackground,
    syncNow: syncAlarms,
  } = useReminderAlarms({
    authedRequest,
    enabled: Boolean(isAuthenticated),
    onOpenReminder: useCallback(
      ({ conversationId }: { reminderId: string; conversationId: string | null }) => {
        // A lead reminder opens its conversation. A personal one - or a lead whose thread has
        // since been deleted - has nowhere specific to land now that reminders live inside a
        // lead's details, so it falls back to the inbox, which is always reachable. The
        // notification itself still fires and still carries its text; only the destination
        // changed.
        if (conversationId) {
          openConversation(conversationId);
          return;
        }

        goToInbox();
      },
      [openConversation, goToInbox],
    ),
  });

  /**
   * The OTHER half of making a reminder reach the owner.
   *
   * `useReminderAlarms` above arms a LOCAL notification, which this app schedules while it is
   * running - so a handset whose owner has not opened Vistaar since the reminder was created
   * never rings. That is what a local notification is. This registers the device with FCM so
   * the server can reach it through the operating system instead, with the app closed and the
   * phone locked. The two are complementary and neither reports the other's success.
   */
  const { register: registerPush, unregister: unregisterPush } = usePushRegistration({
    authedRequest,
    enabled: Boolean(isAuthenticated),
    onOpenReminder: useCallback(
      ({ conversationId }: { taskId: string; conversationId?: string }) => {
        // Same destination rule as a tapped local alarm: a lead reminder opens its thread, a
        // personal one falls back to the inbox.
        if (conversationId) {
          openConversation(conversationId);
          return;
        }

        goToInbox();
      },
      [openConversation, goToInbox],
    ),
  });

  // Asked for once the session exists, not on mount: a permission prompt before sign-in has
  // no reminder to justify it.
  useEffect(() => {
    if (isAuthenticated) {
      void registerPush();
    }
  }, [isAuthenticated, registerPush]);

  /**
   * Sign-out drops this handset first.
   *
   * Without it the device stays registered to the person who just left, and the next
   * reminder for them arrives on a phone somebody else is now holding. Awaited but never
   * allowed to block: a failed cleanup must not trap somebody in a session they asked to
   * leave, and the server retires the token anyway the first time FCM rejects it.
   */
  const handleSignOut = useCallback(async () => {
    await unregisterPush().catch(() => undefined);
    await logout();
  }, [unregisterPush, logout]);

  const canReadAccounts = hasPermission(permissions, PERMISSIONS.ACCOUNTS_READ);
  const canReadUsers = hasPermission(permissions, PERMISSIONS.USERS_READ);
  const canManageStages = hasPermission(permissions, PERMISSIONS.CRM_STAGE_MANAGE);
  const canManageTags = hasPermission(permissions, PERMISSIONS.CRM_TAGS_MANAGE);
  const canManageAiKnowledge = hasPermission(permissions, PERMISSIONS.AI_KNOWLEDGE_MANAGE);
  const canManageLeadSources = hasPermission(permissions, PERMISSIONS.LEAD_SOURCES_MANAGE);
  const canManageSettings = hasPermission(permissions, PERMISSIONS.SETTINGS_MANAGE);
  // The same permission the lead panel's reminder section gates on, so Tasks appears for
  // exactly the people who can already see and act on reminders.
  const canManageTasks = hasPermission(permissions, PERMISSIONS.CRM_TASKS_MANAGE);

  /**
   * Opening a task from the Tasks screen.
   *
   * THE SAME PATH A TAPPED WHATSAPP LINK TAKES. `openConversation` plus `setOpenReminder` is
   * exactly what the deep-link handler above does, so a task opened here and a reminder opened
   * from a notification land on the same thread with the same dialog over it - one destination
   * concept, not two that drift apart.
   *
   * `conversationOriginRef` inside `openConversation` is what makes closing the thread return
   * to Tasks rather than stranding the owner in the inbox.
   */
  const openTaskTarget = useCallback(
    ({ conversationId, reminderId }: { conversationId: string | null; reminderId: string }) => {
      if (!conversationId) {
        // A personal reminder has no lead and no destination. The card does not offer this.
        return;
      }

      openConversation(conversationId);
      setOpenReminder({ reminderId, conversationId });
    },
    [openConversation],
  );

  /**
   * The same sections the masthead strip offers, as data, for the phone's menu sheet. Built
   * from the same permission flags rather than a second list, so a section can never appear in
   * one and not the other.
   */
  /**
   * Filters handed over by an analytics metric card. Bumping `seq` re-keys the inbox list so
   * the same card can be clicked twice and still re-seed - without it the second click would
   * leave whatever filters the owner had since set by hand.
   */
  const [drillDown, setDrillDown] = useState<{
    seq: number;
    filters: { enquiryClass?: string; aiStatus?: string; needsAttention?: boolean };
  } | null>(null);

  /**
   * The analytics page hands back plain strings, because it is describing a metric rather than
   * naming a filter. Narrowed here against the known values instead of cast: a card wired to a
   * bucket the inbox does not have should drop that filter, not smuggle an unmatchable string
   * into a query and quietly return nothing.
   */
  const asEnquiryClass = (value?: string): EnquiryClass | null =>
    value === 'enquiry' || value === 'not_enquiry' || value === 'needs_review' ? value : null;

  const asAiStatus = (value?: string): AiResponseStatus | null =>
    value === 'ai_replied' ||
    value === 'awaiting_ai_reply' ||
    value === 'ai_paused' ||
    value === 'ai_reply_failed' ||
    value === 'ai_not_needed' ||
    value === 'needs_review'
      ? value
      : null;

  const openInboxWithFilters = useCallback(
    (filters: { enquiryClass?: string; aiStatus?: string; needsAttention?: boolean }) => {
      setDrillDown((current) => ({ seq: (current?.seq ?? 0) + 1, filters }));
      setSelectedId(null);
      setView('inbox');
    },
    [],
  );

  const navItems: MobileNavItem<AppView>[] = [
    { view: 'inbox', label: 'Inbox' },
    ...(canManageTasks ? ([{ view: 'tasks', label: 'Tasks' }] as const) : []),
    { view: 'analytics', label: 'Analytics' },
    ...(canReadAccounts ? ([{ view: 'accounts', label: 'Accounts' }] as const) : []),
    ...(canReadUsers ? ([{ view: 'team', label: 'Team' }] as const) : []),
    ...(canManageStages ? ([{ view: 'stages', label: 'Stages' }] as const) : []),
    ...(canManageTags ? ([{ view: 'tags', label: 'Tags' }] as const) : []),
    ...(canManageLeadSources ? ([{ view: 'lead-sources', label: 'Lead sources' }] as const) : []),
    ...(canManageAiKnowledge ? ([{ view: 'ai-knowledge', label: 'Knowledge' }] as const) : []),
    ...(canManageSettings ? ([{ view: 'settings', label: 'Settings' }] as const) : []),
  ];

  // A temporary password must be replaced before anything else is reachable. The backend
  // enforces this too, so this is UX rather than the security boundary.
  if (user?.mustChangePassword) {
    return <ChangePasswordGate />;
  }

  return (
    // `app-shell` swaps 100vh for 100dvh below lg only; see index.css on why the composer
    // ended up under the browser chrome without it.
    <div className="app-shell flex h-screen flex-col bg-ink">
      {/* THE MASTHEAD IS DESKTOP-ONLY NOW.
          It needs ~790px for nine letterspaced labels plus the account controls. On a phone
          navigation has moved to the bottom bar, where the thumb is, and each screen carries
          its own MobileAppBar - so rendering this at all below `lg` would be a second,
          competing set of navigation at the far end of the screen from the hand holding it.
          From `lg` it is exactly what it always was.

          CHOSEN IN JS, NOT HIDDEN BY CSS. Rendering both and letting `lg:hidden` pick put two
          buttons called "Inbox" in the accessibility tree and broke two existing tests: jsdom
          applies no stylesheet media queries, so `findByRole('button', { name: 'Inbox' })`
          matched both and threw. `useIsMobileViewport` reports desktop wherever `matchMedia`
          is absent, so every existing test sees the markup it always saw. */}
      {!isMobileViewport ? (
        <header className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-hairline bg-ink-2/80 px-3 py-2.5 pt-[calc(0.625rem+env(safe-area-inset-top))] backdrop-blur sm:gap-x-3 sm:px-5">
          <span className="wordmark order-1 shrink-0">Vistaar</span>
          {organization?.name ? (
            <span className="order-1 hidden shrink-0 border-l border-hairline pl-5 font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted xl:inline">
              {organization.name}
            </span>
          ) : null}
          <>
            <nav
              aria-label="Sections"
              className="no-scrollbar order-3 -mx-1 flex w-full min-w-0 items-center gap-0.5 overflow-x-auto px-1 lg:order-2 lg:w-auto lg:flex-1"
            >
              <NavButton active={view === 'analytics'} onClick={() => setView('analytics')}>
                Analytics
              </NavButton>
              <NavButton active={view === 'inbox'} onClick={() => setView('inbox')}>
                Inbox
              </NavButton>
              {canManageTasks ? (
                <NavButton active={view === 'tasks'} onClick={() => setView('tasks')}>
                  Tasks
                </NavButton>
              ) : null}
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
            {/* The account controls are a second header line on a phone for things used once
                a week, so on a phone they live in the menu sheet instead. */}
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
                onClick={() => setChangingPassword(true)}
                className="font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted transition-colors hover:text-key"
              >
                Password
              </button>
              <button
                type="button"
                onClick={handleSignOut}
                className="font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted transition-colors hover:text-danger"
              >
                Sign out
              </button>
            </div>
          </>
        </header>
      ) : null}

      {changingPassword ? (
        <ChangePasswordDialog onClose={() => setChangingPassword(false)} />
      ) : null}

      {view === 'tasks' && canManageTasks ? (
        <SectionScreen mobile={isMobileViewport} onBack={goToInbox} title="Tasks">
          <TasksPage onOpenTask={openTaskTarget} />
        </SectionScreen>
      ) : view === 'accounts' && canReadAccounts ? (
        <SectionScreen mobile={isMobileViewport} onBack={goToInbox} title="WhatsApp numbers">
          <AccountsPage />
        </SectionScreen>
      ) : view === 'team' && canReadUsers ? (
        <SectionScreen mobile={isMobileViewport} onBack={goToInbox} title="Team">
          <TeamPage />
        </SectionScreen>
      ) : view === 'stages' && canManageStages ? (
        <SectionScreen mobile={isMobileViewport} onBack={goToInbox} title="Stages">
          <StagesPage />
        </SectionScreen>
      ) : view === 'tags' && canManageTags ? (
        <SectionScreen mobile={isMobileViewport} onBack={goToInbox} title="Tags">
          <TagsPage />
        </SectionScreen>
      ) : view === 'ai-knowledge' && canManageAiKnowledge ? (
        <SectionScreen mobile={isMobileViewport} onBack={goToInbox} title="Knowledge">
          <AiKnowledgePage />
        </SectionScreen>
      ) : view === 'lead-sources' && canManageLeadSources ? (
        <SectionScreen mobile={isMobileViewport} onBack={goToInbox} title="Lead sources">
          <LeadSourcesPage />
        </SectionScreen>
      ) : view === 'analytics' ? (
        <SectionScreen mobile={isMobileViewport} onBack={goToInbox} title="Analytics">
          <AnalyticsPage onOpenConversation={openConversation} onDrillDown={openInboxWithFilters} />
        </SectionScreen>
      ) : view === 'settings' && canManageSettings ? (
        <SectionScreen mobile={isMobileViewport} onBack={goToInbox} title="Settings">
          <SettingsPage />
        </SectionScreen>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Below lg the inbox is a drill-down, not three columns: list, then thread, then
              details. Side by side it gave the thread 18px at laptop widths. From lg the list
              becomes a fixed rail and both panes are visible at once again.

              `m-nav-clearance` only while the list is the visible screen: with a thread open
              the list is hidden and the thread owns the bottom of the screen, where the
              composer - not the nav bar - sits. */}
          <div
            className={`min-h-0 w-full lg:block lg:w-[21rem] lg:shrink-0 xl:w-[23rem] ${
              selectedId ? 'hidden' : 'block'
            } ${isMobileViewport && !selectedId ? 'm-nav-clearance' : ''}`}
          >
            <ConversationList
              key={`list-${listRefreshKey}-${drillDown?.seq ?? 0}`}
              selectedId={selectedId}
              onSelect={selectConversation}
              initialFilters={
                drillDown
                  ? {
                      enquiryClass: asEnquiryClass(drillDown.filters.enquiryClass),
                      aiStatus: asAiStatus(drillDown.filters.aiStatus),
                      needsAttention: drillDown.filters.needsAttention === true,
                    }
                  : undefined
              }
            />
          </div>
          {selectedId ? (
            <ConversationView
              key={selectedId}
              conversationId={selectedId}
              onBack={closeConversation}
              // Reminders are managed inside the lead panel now, so the two things the old
              // Reminders page owned - re-arming device alarms after a change, and telling the
              // owner whether this phone will ring - are handed down to it here.
              onRemindersChanged={syncAlarms}
              remindersRefreshKey={remindersRefreshKey}
              reminderAlarms={
                alarmStatus
                  ? {
                      permission: alarmStatus.permission,
                      exactAlarm: alarmStatus.exactAlarm,
                      onRequestExactAlarm: requestExactAlarm,
                      clockAlarmCount: alarmStatus.clockAlarmCount,
                      clockAlarmsPending: alarmStatus.clockAlarmsPending,
                      clockAlarmUnavailable: alarmStatus.clockAlarmUnavailable,
                      clockAlarmBackgroundGranted: alarmStatus.clockAlarmBackgroundGranted,
                      onRequestClockAlarmBackground: requestClockAlarmBackground,
                      lastSkip: alarmStatus.lastSkip,
                      lastSyncFailed: alarmStatus.lastSyncFailed,
                      armedCount: alarmStatus.armedCount,
                      onRequest: requestNotificationPermission,
                    }
                  : undefined
              }
              onDeleted={() => {
                // Clear the selection first: the backend now 404s this id, so leaving it selected
                // would swap the thread for an error message. Then force the list to refetch, or
                // the deleted row sits there until the next poll.
                dismissDeletedConversation();
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

      {/* THE PHONE'S ONLY NAVIGATION. Hidden whenever a thread is open: that screen ends in
          the composer, and a nav bar under it would sit between the keyboard and the message
          being typed. Back returns to the list, which brings the bar back with it. */}
      {isMobileViewport && !(view === 'inbox' && selectedId) ? (
        <MobileBottomNav
          active={view === 'inbox' ? 'inbox' : 'more'}
          onInbox={goToInbox}
          onMore={() => setMoreOpen(true)}
        />
      ) : null}

      {/* The reminder a notification was about, over its lead.
          Rendered at the shell rather than inside the lead panel on purpose: on a phone that
          panel is a screen the owner has not opened yet, and its reminder list sits behind a
          collapsed disclosure inside it - so a dialog mounted there would not be on screen when
          the link lands. Gated on the selection so it can never hang over a different thread. */}
      {openReminder && selectedId === openReminder.conversationId ? (
        <ReminderDetailDialog
          reminderId={openReminder.reminderId}
          conversationId={openReminder.conversationId}
          onClose={() => setOpenReminder(null)}
          onChanged={() => {
            // Both halves of "something changed": re-arm the device alarms, and make the lead
            // panel behind this refetch so it is not still showing what was just completed.
            syncAlarms();
            setRemindersRefreshKey((value) => value + 1);
          }}
        />
      ) : null}

      {isMobileViewport && moreOpen ? (
        <MobileSectionMenu
          items={navItems}
          activeView={view}
          onSelect={setView}
          onClose={() => setMoreOpen(false)}
          userName={user?.name}
          organizationName={organization?.name}
          onChangePassword={() => setChangingPassword(true)}
          onSignOut={handleSignOut}
        />
      ) : null}
    </div>
  );
};

export default AppShell;

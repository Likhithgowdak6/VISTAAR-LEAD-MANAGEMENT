import { Icons } from '../ui/Icons';
import { PulseDot } from '../ui/Motion';

export type InboxFolder =
  | 'all'
  | 'assigned_to_me'
  | 'unassigned'
  | 'needs_attention'
  | 'starred'
  | 'scheduled'
  | 'collaborations';

type Props = {
  activeFolder: InboxFolder;
  onSelectFolder: (folder: InboxFolder) => void;
  counts?: {
    all?: number;
    assignedToMe?: number;
    unassigned?: number;
    needsAttention?: number;
    starred?: number;
  };
  channels?: Array<{
    id: string;
    name: string;
    status: string;
  }>;
  selectedChannelId?: string | null;
  onSelectChannel?: (id: string | null) => void;
  className?: string;
};

export const InboxSidebar = ({
  activeFolder,
  onSelectFolder,
  counts = {},
  channels = [],
  selectedChannelId = null,
  onSelectChannel,
  className = '',
}: Props) => {
  const navItems: Array<{
    id: InboxFolder;
    label: string;
    icon: keyof typeof Icons;
    count?: number;
    color?: string;
  }> = [
    { id: 'all', label: 'All Inboxes', icon: 'Inbox', count: counts.all },
    {
      id: 'assigned_to_me',
      label: 'Assigned to me',
      icon: 'UserCheck',
      count: counts.assignedToMe,
    },
    { id: 'unassigned', label: 'Unassigned', icon: 'User', count: counts.unassigned },
    {
      id: 'needs_attention',
      label: 'Needs attention',
      icon: 'AlertCircle',
      count: counts.needsAttention,
      color: 'text-amber-500',
    },
    { id: 'starred', label: 'Starred', icon: 'Star', count: counts.starred },
    { id: 'scheduled', label: 'Scheduled', icon: 'Clock' },
    { id: 'collaborations', label: 'Collaborations', icon: 'Users' },
  ];

  return (
    <aside
      className={`glass flex h-full w-64 shrink-0 flex-col overflow-hidden rounded-[1.5rem] transition-all duration-200 select-none ${className}`}
    >
      {/* Top Header */}
      <div className="flex h-16 items-center justify-between px-4 pt-1">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-[0.6rem] bg-blue-600 text-white shadow-sm shadow-blue-500/25">
            <Icons.Inbox size={16} />
          </div>
          <div>
            <h1 className="text-[20px] font-bold leading-tight tracking-tight text-slate-900">Inbox</h1>
            <p className="text-xs text-slate-500">Team Workspace</p>
          </div>
        </div>
        <PulseDot color="bg-emerald-500" pulseColor="bg-emerald-400" size="h-2 w-2" />
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-6">
        {/* Primary Views Section */}
        <div>
          <div className="mb-1.5 px-2.5 text-[13px] font-semibold text-slate-500">
            Views
          </div>
          <nav className="space-y-0.5">
            {navItems.map((item) => {
              const IconComponent = Icons[item.icon];
              const isActive = activeFolder === item.id && !selectedChannelId;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onSelectFolder(item.id);
                    onSelectChannel?.(null);
                  }}
                  className={`group relative flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-[14px] font-medium transition-all duration-150 ${
                    isActive
                      ? 'bg-[#007aff1f] text-blue-600 font-semibold dark:bg-[#0a84ff33] dark:text-blue-400'
                      : 'text-slate-800 hover:bg-[#7676801a] dark:text-slate-200 dark:hover:bg-[#76768033]'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className={`transition-colors duration-150 ${
                        isActive
                          ? 'text-blue-600 dark:text-blue-400'
                          : item.color ?? 'text-blue-600 dark:text-blue-400'
                      }`}
                    >
                      <IconComponent size={16} />
                    </span>
                    <span className="truncate">{item.label}</span>
                  </div>

                  {typeof item.count === 'number' && item.count > 0 ? (
                    <span
                      className={`ml-2 inline-flex items-center justify-center rounded-full px-2 py-0.5 text-[0.625rem] font-bold transition-all ${
                        isActive
                          ? 'bg-blue-600 text-white'
                          : 'bg-slate-100 text-slate-600 group-hover:bg-slate-200/80'
                      }`}
                    >
                      {item.count}
                    </span>
                  ) : null}

                </button>
              );
            })}
          </nav>
        </div>

        {/* WhatsApp & Team Channels Section */}
        {channels.length > 0 && (
          <div>
            <div className="mb-1.5 px-2.5 text-[13px] font-semibold text-slate-500">
              WhatsApp Numbers
            </div>
            <nav className="space-y-0.5">
              {channels.map((chan) => {
                const isActive = selectedChannelId === chan.id;
                return (
                  <button
                    key={chan.id}
                    type="button"
                    onClick={() => onSelectChannel?.(chan.id)}
                    className={`group relative flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-[14px] font-medium transition-all duration-150 ${
                      isActive
                        ? 'bg-[#007aff1f] text-blue-600 font-semibold dark:bg-[#0a84ff33] dark:text-blue-400'
                        : 'text-slate-800 hover:bg-[#7676801a] dark:text-slate-200 dark:hover:bg-[#76768033]'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="text-emerald-500">
                        <Icons.MessageCircle size={15} />
                      </span>
                      <span className="truncate">{chan.name}</span>
                    </div>

                    <span className="flex items-center gap-1.5">
                      <span
                        className={`h-2 w-2 rounded-full ${
                          chan.status === 'active' ? 'bg-emerald-500' : 'bg-slate-300'
                        }`}
                      />
                    </span>
                  </button>
                );
              })}
            </nav>
          </div>
        )}

        {/* AI Assistant Quick Status Box */}
        <div className="rounded-[1.25rem] bg-white/70 p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:bg-white/5">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-blue-600 text-white shadow-sm shadow-blue-500/20 animate-glow-pulse">
              <Icons.Sparkles size={12} />
            </div>
            <span className="text-[13px] font-semibold text-slate-900">AI Auto-Qualify</span>
          </div>
          <p className="mt-1.5 text-[0.6875rem] leading-relaxed text-slate-500">
            Autonomous agent qualifying new wedding & commercial leads 24/7.
          </p>
        </div>
      </div>
    </aside>
  );
};


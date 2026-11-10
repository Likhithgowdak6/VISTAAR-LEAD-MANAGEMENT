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
      className={`flex h-full w-60 shrink-0 flex-col border-r border-slate-200/80 bg-white/70 backdrop-blur-md transition-all duration-200 select-none ${className}`}
    >
      {/* Top Header */}
      <div className="flex h-14 items-center justify-between border-b border-slate-200/70 px-4">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-tr from-blue-600 to-indigo-600 text-white shadow-sm shadow-blue-500/25">
            <Icons.Inbox size={16} />
          </div>
          <div>
            <h1 className="text-xs font-bold uppercase tracking-wider text-slate-800">Inbox</h1>
            <p className="text-[0.625rem] font-medium text-slate-400">Team Workspace</p>
          </div>
        </div>
        <PulseDot color="bg-emerald-500" pulseColor="bg-emerald-400" size="h-2 w-2" />
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-6">
        {/* Primary Views Section */}
        <div>
          <div className="mb-2 px-2 text-[0.6875rem] font-bold uppercase tracking-wider text-slate-400">
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
                  className={`group relative flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-xs font-medium transition-all duration-150 ${
                    isActive
                      ? 'bg-blue-50 text-blue-700 shadow-sm shadow-blue-500/10 font-semibold'
                      : 'text-slate-600 hover:bg-slate-100/80 hover:text-slate-900'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className={`transition-colors duration-150 ${
                        isActive
                          ? 'text-blue-600'
                          : item.color ?? 'text-slate-400 group-hover:text-slate-700'
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

                  {isActive && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-1 left-0 w-1 rounded-r-full bg-blue-600"
                    />
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* WhatsApp & Team Channels Section */}
        {channels.length > 0 && (
          <div>
            <div className="mb-2 px-2 text-[0.6875rem] font-bold uppercase tracking-wider text-slate-400">
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
                    className={`group relative flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-xs font-medium transition-all duration-150 ${
                      isActive
                        ? 'bg-blue-50 text-blue-700 font-semibold shadow-sm'
                        : 'text-slate-600 hover:bg-slate-100/80 hover:text-slate-900'
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
        <div className="rounded-2xl border border-blue-100/80 bg-gradient-to-br from-blue-50/80 via-indigo-50/40 to-white p-3.5 shadow-sm transition-all hover:shadow-md">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-blue-600 text-white shadow-sm shadow-blue-500/20 animate-glow-pulse">
              <Icons.Sparkles size={12} />
            </div>
            <span className="text-xs font-bold text-slate-800">AI Auto-Qualify</span>
          </div>
          <p className="mt-1.5 text-[0.6875rem] leading-relaxed text-slate-500">
            Autonomous agent qualifying new wedding & commercial leads 24/7.
          </p>
        </div>
      </div>
    </aside>
  );
};


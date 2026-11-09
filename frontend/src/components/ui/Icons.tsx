import { type SVGProps } from 'react';

export type IconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
  className?: string;
};

const createIcon = (d: string | string[], viewBox = '0 0 24 24') => {
  const Icon = ({ size = 18, className = '', ...props }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      {...props}
    >
      {Array.isArray(d) ? (
        d.map((path, idx) => <path key={idx} d={path} />)
      ) : (
        <path d={d} />
      )}
    </svg>
  );
  return Icon;
};

export const Icons = {
  Inbox: createIcon([
    'M22 12h-6l-2 3h-4l-2-3H2',
    'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  ]),
  User: createIcon([
    'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2',
    'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  ]),
  Users: createIcon([
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
    'M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
    'M22 21v-2a4 4 0 0 0-3-3.87',
    'M16 3.13a4 4 0 0 1 0 7.75',
  ]),
  UserCheck: createIcon([
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
    'M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
    'm16 11 2 2 4-4',
  ]),
  Search: createIcon([
    'M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z',
    'm21 21-4.3-4.3',
  ]),
  Check: createIcon('M20 6 9 17l-5-5'),
  CheckCircle2: createIcon([
    'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z',
    'm9 12 2 2 4-4',
  ]),
  AlertCircle: createIcon([
    'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z',
    'M12 8v4',
    'M12 16h.01',
  ]),
  ChevronDown: createIcon('m6 9 6 6 6-6'),
  ChevronUp: createIcon('m18 15-6-6-6 6'),
  ChevronRight: createIcon('m9 18 6-6-6-6'),
  ChevronLeft: createIcon('m15 18-6-6 6-6'),
  Phone: createIcon(
    'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z'
  ),
  Calendar: createIcon([
    'M8 2v4',
    'M16 2v4',
    'M3 10h18',
    'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  ]),
  Clock: createIcon([
    'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z',
    'M12 6v6l4 2',
  ]),
  Star: createIcon(
    'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z'
  ),
  Tag: createIcon([
    'M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2z',
    'M7 7h.01',
  ]),
  MessageSquare: createIcon([
    'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  ]),
  Send: createIcon([
    'm22 2-7 20-4-9-9-4Z',
    'M22 2 11 13',
  ]),
  Paperclip: createIcon(
    'm21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48'
  ),
  MoreVertical: createIcon([
    'M12 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
    'M12 5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
    'M12 19a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  ]),
  MoreHorizontal: createIcon([
    'M12 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
    'M19 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
    'M5 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  ]),
  RefreshCw: createIcon([
    'M3 12a9 9 0 0 1 15-6.7L21 8',
    'M21 3v5h-5',
    'M21 12a9 9 0 0 1-15 6.7L3 16',
    'M3 21v-5h5',
  ]),
  Sparkles: createIcon([
    'm12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z',
  ]),
  Filter: createIcon(
    'M22 3H2l8 9.46V19l4 2v-8.54L22 3z'
  ),
  Shield: createIcon(
    'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'
  ),
  Activity: createIcon('M22 12h-4l-3 9L9 3l-3 9H2'),
  BarChart3: createIcon([
    'M3 3v18h18',
    'M18 17V9',
    'M13 17V5',
    'M8 17v-3',
  ]),
  Settings: createIcon([
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  ]),
  Bell: createIcon([
    'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9',
    'M13.73 21a2 2 0 0 1-3.46 0',
  ]),
  Zap: createIcon('M13 2 3 14h9l-1 8 10-12h-9l1-8z'),
  Bot: createIcon([
    'M12 8V4H8',
    'M2 14h2',
    'M20 14h2',
    'M15 13v2',
    'M9 13v2',
    'M4 10a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z',
  ]),
  ArrowRight: createIcon([
    'M5 12h14',
    'm12 5 7 7-7 7',
  ]),
  ArrowLeft: createIcon([
    'M19 12H5',
    'm12 19-7-7 7-7',
  ]),
  X: createIcon([
    'M18 6 6 18',
    'm6 6 12 12',
  ]),
  Plus: createIcon([
    'M5 12h14',
    'M12 5v14',
  ]),
  LogOut: createIcon([
    'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4',
    'm16 17 5-5-5-5',
    'M21 12H9',
  ]),
  Lock: createIcon([
    'M7 11V7a5 5 0 0 1 10 0v4',
    'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z',
  ]),
  Trash2: createIcon([
    'M3 6h18',
    'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
    'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
    'M10 11v6',
    'M14 11v6',
  ]),
  Eye: createIcon([
    'M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z',
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  ]),
  EyeOff: createIcon([
    'M9.88 9.88a3 3 0 1 0 4.24 4.24',
    'M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68',
    'M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61',
    'm2 2 20 20',
  ]),
  LayoutGrid: createIcon([
    'M3 3h7v7H3z',
    'M14 3h7v7h-7z',
    'M14 14h7v7h-7z',
    'M3 14h7v7H3z',
  ]),
  CheckSquare: createIcon([
    'm9 11 3 3L22 4',
    'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  ]),
  Layers: createIcon([
    'm12 2 10 5-10 5L2 7l10-5z',
    'm2 17 10 5 10-5',
    'm2 12 10 5 10-5',
  ]),
  Folder: createIcon(
    'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'
  ),
  Smile: createIcon([
    'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z',
    'M8 14s1.5 2 4 2 4-2 4-2',
    'M9 9h.01',
    'M15 9h.01',
  ]),
  Download: createIcon([
    'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4',
    'm7 10 5 5 5-5',
    'M12 15V3',
  ]),
  Play: createIcon(
    'm5 3 14 9-14 9V3z'
  ),
  Mic: createIcon([
    'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z',
    'M19 10v2a7 7 0 0 1-14 0v-2',
    'M12 19v4',
    'M8 23h8',
  ]),
  FileText: createIcon([
    'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z',
    'M14 2v4a2 2 0 0 0 2 2h4',
    'M10 9H8',
    'M16 13H8',
    'M16 17H8',
  ]),
  Image: createIcon([
    'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z',
    'm21 15-5-5L5 21',
    'M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  ]),
  ExternalLink: createIcon([
    'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
    'm15 3 6 6',
    'M10 14 21 3',
  ]),
  Flame: createIcon(
    'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z'
  ),
  MessageCircle: createIcon([
    'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z',
  ]),
};


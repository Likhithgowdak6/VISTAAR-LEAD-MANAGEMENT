import {
  type ReactNode,
  useRef,
  useState,
  useEffect,
  type MouseEvent,
  type HTMLAttributes,
} from 'react';

/**
 * 3D tilt card that tracks pointer position and gently rotates in 3D space.
 */
export const Card3D = ({
  children,
  className = '',
  maxRotation = 8,
  scale = 1.02,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  maxRotation?: number;
  scale?: number;
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState({});

  const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const rotateX = ((y - centerY) / centerY) * -maxRotation;
    const rotateY = ((x - centerX) / centerX) * maxRotation;

    setStyle({
      transform: `perspective(1000px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) scale3d(${scale}, ${scale}, ${scale})`,
      transition: 'transform 100ms ease-out',
    });
  };

  const handleMouseLeave = () => {
    setStyle({
      transform: 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)',
      transition: 'transform 500ms cubic-bezier(0.16, 1, 0.3, 1)',
    });
  };

  return (
    <div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={style}
      className={`transform-gpu ${className}`}
      {...props}
    >
      {children}
    </div>
  );
};

/**
 * Subtle magnetic attraction for primary action buttons.
 */
export const MagneticButton = ({
  children,
  className = '',
  strength = 15,
  onClick,
  disabled = false,
  ...props
}: HTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  strength?: number;
  onClick?: () => void;
  disabled?: boolean;
}) => {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0 });

  const handleMouseMove = (e: MouseEvent<HTMLButtonElement>) => {
    if (disabled || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const x = e.clientX - (rect.left + rect.width / 2);
    const y = e.clientY - (rect.top + rect.height / 2);
    setTransform({
      x: (x / rect.width) * strength,
      y: (y / rect.height) * strength,
    });
  };

  const handleMouseLeave = () => {
    setTransform({ x: 0, y: 0 });
  };

  return (
    <button
      ref={btnRef}
      disabled={disabled}
      onClick={onClick}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        transition: transform.x === 0 ? 'transform 400ms cubic-bezier(0.16, 1, 0.3, 1)' : 'transform 80ms ease-out',
      }}
      className={`relative inline-flex items-center justify-center font-semibold transition-shadow active:scale-95 disabled:pointer-events-none disabled:opacity-50 ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};

/**
 * Animated counter that counts from 0 to value smoothly.
 */
export const AnimatedCounter = ({
  value,
  duration = 1000,
  prefix = '',
  suffix = '',
  className = '',
}: {
  value: number;
  duration?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
}) => {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let start = 0;
    const end = value;
    if (start === end) {
      setCount(end);
      return;
    }

    const totalSteps = 40;
    const stepTime = duration / totalSteps;
    const increment = (end - start) / totalSteps;

    const timer = setInterval(() => {
      start += increment;
      if ((increment > 0 && start >= end) || (increment < 0 && start <= end)) {
        setCount(end);
        clearInterval(timer);
      } else {
        setCount(Math.round(start));
      }
    }, stepTime);

    return () => clearInterval(timer);
  }, [value, duration]);

  return (
    <span className={`tabular-nums font-bold ${className}`}>
      {prefix}
      {count.toLocaleString()}
      {suffix}
    </span>
  );
};

/**
 * Shimmer skeleton placeholder for smooth loading states.
 */
export const Shimmer = ({
  className = 'h-4 w-full rounded',
}: {
  className?: string;
}) => (
  <div className={`relative overflow-hidden bg-slate-100 ${className}`}>
    <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.6s_infinite] bg-gradient-to-r from-transparent via-white/70 to-transparent" />
  </div>
);

/**
 * Pulsing live dot for active status.
 */
export const PulseDot = ({
  color = 'bg-emerald-500',
  pulseColor = 'bg-emerald-400',
  size = 'h-2.5 w-2.5',
}: {
  color?: string;
  pulseColor?: string;
  size?: string;
}) => (
  <span className="relative flex shrink-0 items-center justify-center">
    <span
      className={`absolute inline-flex ${size} animate-ping rounded-full opacity-75 ${pulseColor}`}
    />
    <span className={`relative inline-flex ${size} rounded-full ${color}`} />
  </span>
);

/**
 * Circular modern Avatar with deterministic gradient from name string.
 */
export const Avatar = ({
  name = 'Guest',
  src,
  size = 'md',
  status,
  className = '',
}: {
  name?: string;
  src?: string | null;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  status?: 'active' | 'away' | 'offline' | 'ai';
  className?: string;
}) => {
  const sizeMap = {
    xs: 'w-6 h-6 text-[0.625rem]',
    sm: 'w-8 h-8 text-xs',
    md: 'w-10 h-10 text-sm',
    lg: 'w-12 h-12 text-base',
    xl: 'w-14 h-14 text-lg',
  };

  const getInitials = (n: string) => {
    const parts = n.trim().split(/\s+/);
    if (!parts.length || !parts[0]) return 'V';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  };

  // Deterministic vibrant gradient based on name hash
  const getGradient = (n: string) => {
    const gradients = [
      'from-blue-600 to-indigo-600 text-white',
      'from-indigo-600 to-violet-600 text-white',
      'from-violet-600 to-purple-600 text-white',
      'from-sky-500 to-blue-600 text-white',
      'from-emerald-500 to-teal-600 text-white',
      'from-amber-500 to-orange-600 text-white',
      'from-rose-500 to-pink-600 text-white',
      'from-teal-500 to-cyan-600 text-white',
    ];
    let hash = 0;
    for (let i = 0; i < n.length; i++) {
      hash = n.charCodeAt(i) + ((hash << 5) - hash);
    }
    const idx = Math.abs(hash) % gradients.length;
    return gradients[idx];
  };

  return (
    <div className={`relative shrink-0 ${sizeMap[size]} ${className}`}>
      {src ? (
        <img
          src={src}
          alt={name}
          className="h-full w-full rounded-full object-cover shadow-sm ring-1 ring-slate-200"
        />
      ) : (
        <div
          className={`flex h-full w-full items-center justify-center rounded-full bg-gradient-to-tr font-bold shadow-sm ring-2 ring-white ${getGradient(
            name
          )}`}
        >
          {getInitials(name)}
        </div>
      )}
      {status && (
        <span className="absolute bottom-0 right-0 block h-2.5 w-2.5 rounded-full ring-2 ring-white">
          {status === 'active' && <span className="block h-full w-full rounded-full bg-emerald-500" />}
          {status === 'away' && <span className="block h-full w-full rounded-full bg-amber-500" />}
          {status === 'offline' && <span className="block h-full w-full rounded-full bg-slate-400" />}
          {status === 'ai' && <span className="block h-full w-full rounded-full bg-violet-500" />}
        </span>
      )}
    </div>
  );
};


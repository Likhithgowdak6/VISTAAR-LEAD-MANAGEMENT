import { useState, type ChangeEvent, type FormEvent } from 'react';

import { useAuth } from '../auth/AuthContext';

type LoginForm = {
  organizationSlug: string;
  email: string;
  password: string;
};

type AuthValue = {
  login: (credentials: LoginForm) => Promise<void>;
};

const LoginPage = () => {
  const { login } = useAuth() as AuthValue;
  const [form, setForm] = useState<LoginForm>({
    organizationSlug: '',
    email: '',
    password: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const updateField = (field: keyof LoginForm) => (event: ChangeEvent<HTMLInputElement>) => {
    setForm((current) => ({ ...current, [field]: event.target.value }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await login(form);
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : 'Unable to sign in.');
    } finally {
      setSubmitting(false);
    }
  };

  // iOS grouped-form rows: label on the left, borderless field on the right, hairline between.
  const rowClass = 'flex items-center gap-3 px-4 min-h-[52px]';
  const labelClass = 'w-28 shrink-0 text-[15px] font-medium text-slate-900';
  const inputClass =
    'min-w-0 flex-1 !rounded-none !border-0 !bg-transparent py-3 text-[15px] text-slate-900 !shadow-none placeholder:text-slate-400 focus:!outline-none';

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden p-5">
      {/* Wallpaper: soft colour fields for the glass card to sit on. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute -left-32 -top-32 h-[28rem] w-[28rem] rounded-full bg-blue-500/25 blur-3xl dark:bg-blue-500/30" />
        <div className="absolute -right-24 top-1/4 h-[24rem] w-[24rem] rounded-full bg-purple-500/20 blur-3xl dark:bg-purple-500/25" />
        <div className="absolute -bottom-40 left-1/4 h-[26rem] w-[26rem] rounded-full bg-sky-400/20 blur-3xl dark:bg-sky-400/20" />
      </div>

      <section className="glass animate-rise relative w-full max-w-[26rem] rounded-[2.25rem] p-6 sm:p-8">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-[1.1rem] bg-blue-600 text-white shadow-lg shadow-blue-500/30">
            <span className="text-[28px] font-bold tracking-tight">V</span>
          </div>
          <h1 className="text-[28px] font-bold leading-tight tracking-tight text-slate-900">Sign in</h1>
          <p className="mt-1.5 text-[15px] text-slate-500">Use your Vistaar workspace account</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5" aria-label="Sign in">
          <div className="divide-y divide-black/[0.08] overflow-hidden rounded-[1.25rem] bg-white/80 shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:divide-white/10 dark:bg-white/[0.06]">
            <div className={rowClass}>
              <label htmlFor="organizationSlug" className={labelClass}>
                Organization
              </label>
              <input
                id="organizationSlug"
                type="text"
                autoComplete="organization"
                autoCapitalize="none"
                required
                value={form.organizationSlug}
                onChange={updateField('organizationSlug')}
                placeholder="your-org"
                className={inputClass}
              />
            </div>

            <div className={rowClass}>
              <label htmlFor="email" className={labelClass}>
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                required
                value={form.email}
                onChange={updateField('email')}
                placeholder="name@example.com"
                className={inputClass}
              />
            </div>

            <div className={rowClass}>
              <label htmlFor="password" className={labelClass}>
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={form.password}
                onChange={updateField('password')}
                placeholder="Required"
                className={inputClass}
              />
            </div>
          </div>

          {error ? (
            <p
              role="alert"
              className="rounded-[1rem] bg-red-500/10 px-4 py-3 text-[13px] font-medium text-red-600 dark:text-red-400"
            >
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-full bg-blue-600 px-4 py-3.5 text-[17px] font-semibold text-white transition-all hover:bg-blue-500 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
};

export default LoginPage;

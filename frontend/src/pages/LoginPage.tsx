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

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 via-blue-50/30 to-indigo-50/20 p-6 selection:bg-blue-600 selection:text-white">
      <section className="animate-rise relative w-full max-w-md rounded-2xl border border-slate-200/80 bg-white/95 p-8 shadow-xl shadow-slate-200/50 backdrop-blur-md md:p-10">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 left-1/2 h-48 w-48 -translate-x-1/2 rounded-full bg-blue-500/10 blur-3xl"
        />

        <div className="relative">
          <div className="mb-6 flex flex-col items-center text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 text-white shadow-md shadow-blue-500/30">
              <span className="font-mono text-xl font-black tracking-tight">V</span>
            </div>
            <p className="wordmark text-sm font-bold uppercase tracking-widest text-blue-600">Vistaar</p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">Sign in</h1>
            <p className="mt-1 text-xs text-slate-500">Enter your credentials to access your CRM workspace</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4" aria-label="Sign in">
            <div>
              <label
                htmlFor="organizationSlug"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-700"
              >
                Organization
              </label>
              <input
                id="organizationSlug"
                type="text"
                autoComplete="organization"
                required
                value={form.organizationSlug}
                onChange={updateField('organizationSlug')}
                placeholder="your-org-slug"
                className="w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 transition-all focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>

            <div>
              <label
                htmlFor="email"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-700"
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={form.email}
                onChange={updateField('email')}
                placeholder="name@example.com"
                className="w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 transition-all focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-700"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={form.password}
                onChange={updateField('password')}
                placeholder="••••••••"
                className="w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 transition-all focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>

            {error ? (
              <p
                role="alert"
                className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-semibold text-red-700"
              >
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-3 text-sm font-semibold tracking-wide text-white shadow-md shadow-blue-500/25 transition-all hover:from-blue-700 hover:to-indigo-700 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
};

export default LoginPage;

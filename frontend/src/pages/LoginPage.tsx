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
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <section className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="mb-1 text-sm font-semibold text-blue-600">WAM CRM AI</p>
        <h1 className="mb-6 text-2xl font-bold text-slate-900">Sign in</h1>

        <form onSubmit={handleSubmit} className="space-y-4" aria-label="Sign in">
          <div>
            <label
              htmlFor="organizationSlug"
              className="mb-1 block text-sm font-medium text-slate-700"
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
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium text-slate-700">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={form.email}
              onChange={updateField('email')}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-slate-700">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={form.password}
              onChange={updateField('password')}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 focus:border-blue-500 focus:outline-none"
            />
          </div>

          {error ? (
            <p role="alert" className="text-sm font-medium text-red-600">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
};

export default LoginPage;

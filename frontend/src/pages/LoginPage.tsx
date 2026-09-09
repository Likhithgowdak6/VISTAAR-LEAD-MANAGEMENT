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
    <main className="flex min-h-screen items-center justify-center p-6">
      {/*
       * The way into the console is lit like a set: one warm key light behind the panel, and
       * nothing else on screen. It is the studio's own medium used as the entrance, and it is the
       * only place in the app where the glow is allowed to be the subject.
       */}
      <section className="animate-rise surface relative w-full max-w-sm rounded-xl p-8">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-x-8 -top-16 h-32 rounded-full bg-key/20 blur-3xl"
        />

        <div className="relative">
          <p className="wordmark mb-1">Vistaar</p>
          {/* The page's heading, set as the eyebrow. It stays an h1 saying "Sign in" because that
              is the page's actual job - the wordmark above is the brand, not the heading. */}
          <h1 className="eyebrow mb-7">Sign in</h1>

          <form onSubmit={handleSubmit} className="space-y-4" aria-label="Sign in">
          <div>
            <label
              htmlFor="organizationSlug"
              className="mb-1 block font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted"
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
              className="w-full rounded-md border border-hairline bg-ink px-3 py-2 text-bone transition-colors placeholder:text-muted focus:border-key/50 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="email"
              className="mb-1 block font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted"
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
              className="w-full rounded-md border border-hairline bg-ink px-3 py-2 text-bone transition-colors placeholder:text-muted focus:border-key/50 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="mb-1 block font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted"
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
              className="w-full rounded-md border border-hairline bg-ink px-3 py-2 text-bone transition-colors placeholder:text-muted focus:border-key/50 focus:outline-none"
            />
          </div>

            {error ? (
              <p
                role="alert"
                className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
              >
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={submitting}
              className="btn-key w-full rounded-md px-4 py-2.5 text-sm uppercase tracking-[0.08em] transition disabled:cursor-not-allowed"
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

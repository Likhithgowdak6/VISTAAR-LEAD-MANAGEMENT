import { AuthProvider, useAuth } from './auth/AuthContext';
import AppShell from './pages/AppShell';
import LoginPage from './pages/LoginPage';
import Spinner from './components/Spinner';
import { RealtimeProvider } from './realtime/RealtimeProvider';
import { ThemeProvider } from './context/ThemeContext';

const AuthenticatedApp = () => {
  const { isAuthenticated, bootstrapping } = useAuth();

  if (bootstrapping) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-100">
        <Spinner label="Loading…" />
      </main>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <RealtimeProvider>
      <AppShell />
    </RealtimeProvider>
  );
};

const App = () => (
  <ThemeProvider>
    <AuthProvider>
      <AuthenticatedApp />
    </AuthProvider>
  </ThemeProvider>
);

export default App;

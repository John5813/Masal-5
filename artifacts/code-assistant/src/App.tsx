import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@workspace/replit-auth-web";
import WorkspacePage from "@/pages/workspace";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();

function LoginScreen() {
  const { login } = useAuth();
  return (
    <div className="min-h-screen bg-[#0a0a14] flex flex-col items-center justify-center text-[#c0caf5]">
      <div className="flex flex-col items-center gap-6 max-w-sm w-full px-6">
        <div className="text-5xl text-[#7aa2f7]/30 mb-2">◆</div>
        <h1 className="text-2xl font-bold tracking-tight text-[#c0caf5]">UzCoder</h1>
        <p className="text-sm text-[#565f89] text-center leading-relaxed">
          AI yordamida kod yozuvchi to'liq muhit. Kirish uchun hisobingiz talab etiladi.
        </p>
        <button
          onClick={login}
          className="w-full py-3 px-6 bg-[#7aa2f7]/10 hover:bg-[#7aa2f7]/20 border border-[#7aa2f7]/30 text-[#7aa2f7] rounded-xl font-medium text-sm transition-colors"
        >
          Kirish
        </button>
      </div>
    </div>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { isLoading, isAuthenticated } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#0a0a14] flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-[#7aa2f7] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) return <LoginScreen />;
  return <>{children}</>;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={WorkspacePage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AuthGate>
            <Router />
          </AuthGate>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

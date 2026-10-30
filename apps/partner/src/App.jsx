import { useMemo } from "react";
import { AuthProvider, useAuth } from "./contexts/AuthContext.jsx";
import { RiderProvider, useRider } from "./contexts/RiderContext.jsx";
import { createRiderApi, createSupabase } from "./services/supabaseClient.js";
import { LoginScreen, PendingScreen, RegisterScreen } from "./components/AuthScreens.jsx";
import Profile from "./components/Profile.jsx";
import Dashboard from "./components/Dashboard.jsx";
import ActiveOrderFlow from "./components/ActiveOrderFlow.jsx";
import { NewJobOverlay, SyncBar } from "./components/Overlays.jsx";
import { OfferOverlay } from "./components/OfferOverlay.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import Watermark from "./components/Watermark.jsx";

const Splash = ({ text = "Loading…" }) => <main className="auth"><div className="logo">+</div><p className="muted">{text}</p></main>;

function Gate() {
  const { signOut } = useAuth(); const { rider, job, api } = useRider();
  if (rider === undefined) return <Splash />;
  if (rider === null) return <RegisterScreen onSignOut={signOut} />;
  if (rider.verificationStatus === "SUSPENDED" || (rider.verificationStatus !== "VERIFIED" && typeof api?.getMyKyc !== "function")) return <PendingScreen onSignOut={signOut} />;
  if (rider.verificationStatus !== "VERIFIED") return <Profile onboarding onSignOut={signOut} />;      // add documents -> operator approves -> this screen flips to the dashboard by itself
  return (<><SyncBar />{job ? <ActiveOrderFlow /> : <Dashboard onSignOut={signOut} />}<NewJobOverlay /><OfferOverlay /></>);
}

function Shell({ geo }) {
  const { api, session, loading, signOut } = useAuth();
  if (loading) return <Splash />;
  if (!session) return <LoginScreen api={api} />;
  return <RiderProvider api={api} session={session} onSignOut={signOut} geo={geo}><Gate /></RiderProvider>;
}

export default function App({ api: injected, geo }) {
  const api = useMemo(() => { if (injected) return injected; try { return createRiderApi(createSupabase()); } catch (e) { return { configError: e.message }; } }, [injected]);
  if (api.configError) return <><Watermark /><main className="auth"><h2>App not configured</h2><p className="muted">{api.configError}. Copy <code>.env.example</code> to <code>.env</code> and fill in your Supabase URL and anon key.</p></main></>;
  return <ErrorBoundary name="app" reload><Watermark /><AuthProvider api={api}><Shell geo={geo} /></AuthProvider></ErrorBoundary>;
}

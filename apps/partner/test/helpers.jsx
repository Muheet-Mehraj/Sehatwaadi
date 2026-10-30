import React from "react";
import { useRider } from "../src/contexts/RiderContext.jsx";
import Dashboard from "../src/components/Dashboard.jsx";
import ActiveOrderFlow from "../src/components/ActiveOrderFlow.jsx";
// Same gating as App.jsx: nothing until the rider has loaded, then the job screen or the dashboard.
export const TestGate = () => { const { rider, job } = useRider(); if (!rider) return null; return job ? <ActiveOrderFlow /> : <Dashboard onSignOut={() => {}} />; };

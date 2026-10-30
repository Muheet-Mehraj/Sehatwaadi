import { Component } from "react";
// Keeps one broken widget (e.g. the map) from blanking the whole screen while a rider is mid-delivery.
export default class ErrorBoundary extends Component {
  state = { err: null };
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.error("[ErrorBoundary]", this.props.name || "", err, info?.componentStack); }
  render() {
    if (!this.state.err) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    return <div className="note err">Something went wrong here. <button className="btn ghost" onClick={() => this.setState({ err: null })}>Try again</button>{this.props.reload && <button className="btn ghost" onClick={() => location.reload()}>Reload app</button>}</div>;
  }
}

// Forms' own interface (Ferrum docs/plan/apps-ui.md §13) at /forms/: the page a form's link opens
// for anyone (/f/{workspace}/{form}, no sign-in and no bar), and for the people who build them,
// the list of forms, the builder and the results, with the rest of Forms' records in the frame
// under the platform's bar. The two halves load apart: answering a form downloads nothing of the
// builder, nor of the frame.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, RouterProvider, useRouteError } from "react-router";
import { routeBase } from "@ferrum/client";
import { ConfirmHost, EmptyState, ErrorState, Spinner, Toaster } from "@ferrum/kit";
import "./styles.css";

/** A page of the records frame, loaded when first opened. */
const page = (name: "FormView" | "ListView" | "ReportView" | "AppSettingsPage" | "ScreenPage") => () =>
  import("./records").then((m) => ({ Component: m[name] }));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 } },
});

function RouteError() {
  return <ErrorState error={useRouteError()} onRetry={() => window.location.reload()} />;
}

function NotFound() {
  return (
    <EmptyState title="Page not found">
      <Link to="/">Go to Forms</Link>
    </EmptyState>
  );
}

/** What a page shows while its code loads for the first time. */
const opening = (
  <div className="fr-loading" role="status">
    <Spinner />
    <span className="muted">Opening…</span>
  </div>
);

const router = createBrowserRouter(
  [
    // The pages anyone with a link opens.
    { path: "f/:tenant/:slug", lazy: () => import("./Respond").then((m) => ({ Component: m.RespondPage })), errorElement: <RouteError />, hydrateFallbackElement: opening },
    { path: "f/:tenant/:slug/result/:token", lazy: () => import("./Respond").then((m) => ({ Component: m.ResultPage })), errorElement: <RouteError />, hydrateFallbackElement: opening },
    {
      path: "/",
      lazy: () => import("./Manage").then((m) => ({ Component: m.Managed })),
      errorElement: <RouteError />,
      hydrateFallbackElement: opening,
      children: [
        { path: "e/:entity", lazy: page("ListView") },
        { path: "e/:entity/:id", lazy: page("FormView") },
        { path: "r/:name", lazy: page("ReportView") },
        { path: "apps/:app/settings", lazy: page("AppSettingsPage") },
        { path: "x/:app/:page", lazy: page("ScreenPage") },
        { path: "*", element: <NotFound /> },
      ],
    },
  ],
  { basename: routeBase("forms") },
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
      <ConfirmHost />
    </QueryClientProvider>
  </StrictMode>,
);

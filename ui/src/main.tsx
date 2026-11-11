// Forms' own interface (Ferrum docs/plan/apps-ui.md §13) at /forms/: the page a form's link opens
// for anyone (/f/{workspace}/{form}, no sign-in and no bar), and for the people who build them,
// the list of forms, the builder and the results, with the rest of Forms' records in the frame
// under the platform's bar. The two halves load apart: answering a form downloads nothing of the
// builder, nor of the frame.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, RouterProvider, useRouteError } from "react-router";
import { addCatalogs, routeBase, t, wordsReady } from "@ferrum/client";
import { ConfirmHost, EmptyState, ErrorState, FormSkeleton, Toaster } from "@ferrum/kit";
import "./styles.css";

// Its own words in the page's language (src/locales), fetched as the page starts; it is drawn once they are in.
void addCatalogs({ ar: () => import("./locales/ar.json"), hi: () => import("./locales/hi.json") });

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
    <EmptyState title={t("Page not found")}>
      <Link to="/">{t("Go to Forms")}</Link>
    </EmptyState>
  );
}

/** What a page shows while its code loads for the first time. */
const opening = <FormSkeleton />;

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
        { index: true, lazy: () => import("./Home").then((m) => ({ Component: m.Home })) },
        { path: "e/Form", lazy: () => import("./Home").then((m) => ({ Component: m.Home })) },
        { path: "new", lazy: () => import("./New").then((m) => ({ Component: m.New })) },
        { path: "b/:id", lazy: () => import("./Builder").then((m) => ({ Component: m.BuilderRoute })) },
        { path: "b/:id/results", lazy: () => import("./Results").then((m) => ({ Component: m.ResultsRoute })) },
        { path: "response/:id", lazy: () => import("./Results").then((m) => ({ Component: m.ResponseRoute })) },
        // A response in the records list opens where its answers can be read.
        { path: "e/FormResponse/:id", lazy: () => import("./Results").then((m) => ({ Component: m.ResponseRoute })) },
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

// Drawn once the page's words are in (its language's catalogs, fetched as the page starts).
void wordsReady().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <Toaster />
        <ConfirmHost />
      </QueryClientProvider>
    </StrictMode>,
  ),
);

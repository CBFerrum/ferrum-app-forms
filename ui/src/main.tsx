// Forms' own interface (Ferrum docs/plan/apps-ui.md §13) at /forms/: the page a form's link opens
// for anyone (/f/{workspace}/{form}, no sign-in and no bar), and for the people who build them,
// the list of forms, the builder and the results, with the rest of Forms' records in the frame
// under the platform's bar. The two halves load apart: answering a form downloads nothing of the
// builder, nor of the frame.

import { Link, useRouteError } from "react-router";
import { t } from "@ferrum/client";
import { EmptyState, ErrorState, FormSkeleton } from "@ferrum/kit";
import { mountApp } from "@ferrum/records/frame";
import "./styles.css";

/** A page of the records frame, loaded when first opened. */
const page = (name: "FormView" | "ListView" | "ReportView") => () => import("./records").then((m) => ({ Component: m[name] }));

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

mountApp({
  route: "forms",
  catalogs: { ar: () => import("./locales/ar.json"), hi: () => import("./locales/hi.json") },
  routes: [
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
        { path: "*", element: <NotFound /> },
      ],
    },
  ],
});

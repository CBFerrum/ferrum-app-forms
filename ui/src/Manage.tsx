// The part of the interface for people who build forms: the records frame around it (Forms'
// modules in the sidebar under the platform's bar). A respondent's page never loads it.

import { useEffect } from "react";
import { shell } from "@ferrum/client";
import { RequireAuth, setFrameMode } from "@ferrum/records/frame";

/** Forms' packages: the sidebar shows their modules. */
setFrameMode("app", ["forms"]);

/** Every page tells the shell it started. */
export function Managed() {
  useEffect(() => shell().ready(), []);
  return <RequireAuth />;
}

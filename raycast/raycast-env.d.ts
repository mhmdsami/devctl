/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** devctl Path - Absolute path to the devctl executable. Defaults to the install script location. */
  "devctlPath": string,
  /** Editor App - App name used by Open in Editor (passed to open -a). */
  "editorApp": string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `menubar` command */
  export type Menubar = ExtensionPreferences & {}
  /** Preferences accessible in the `manage` command */
  export type Manage = ExtensionPreferences & {}
  /** Preferences accessible in the `create-stack` command */
  export type CreateStack = ExtensionPreferences & {}
  /** Preferences accessible in the `switch-env` command */
  export type SwitchEnv = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `menubar` command */
  export type Menubar = {}
  /** Arguments passed to the `manage` command */
  export type Manage = {}
  /** Arguments passed to the `create-stack` command */
  export type CreateStack = {}
  /** Arguments passed to the `switch-env` command */
  export type SwitchEnv = {}
}


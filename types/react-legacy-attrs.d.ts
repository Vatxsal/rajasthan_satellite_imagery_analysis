/**
 * React's type definitions omit the legacy `bgcolor` attribute, but email
 * clients (notably Outlook desktop) honour it on table rows/cells where
 * CSS `background-color` is unreliable. The template sets both.
 */
import "react";

declare module "react" {
  interface HTMLAttributes<T> {
    bgcolor?: string;
  }
  interface TdHTMLAttributes<T> {
    bgcolor?: string;
  }
}

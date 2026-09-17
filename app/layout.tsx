import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ToastProvider } from "@/components/toast";

import "./globals.css";

export const metadata: Metadata = {
  title: "NerTube",
  description: "A YouTube production pipeline: idea to published.",
};

/**
 * `ToastProvider` is mounted here, once, rather than per page: a capture made
 * from the header and a move refused on the board are the same kind of message
 * in the same corner of the screen, and one of them happens on every route the
 * header is on. One provider is also what makes "exactly one toast mechanism"
 * true rather than aspirational — there is nowhere else to put a second one.
 *
 * It is a client component wrapping the tree, which does not make the tree a
 * client tree: `children` is still rendered on the server and passed through.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full bg-background font-sans text-foreground antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}

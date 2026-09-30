import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Kaushan_Script } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Brush script for the "Fury" wordmark in the header
const kaushan = Kaushan_Script({
  variable: "--font-kaushan",
  weight: "400",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Fury IDE",
  description: "A powerful IDE for AI-assisted development",
  // iOS "Add to Home Screen": run standalone, let the shell draw under the status bar
  // (app/manifest.ts covers Android/desktop; app/apple-icon.png is linked automatically).
  appleWebApp: {
    capable: true,
    title: "Fury",
    statusBarStyle: "black-translucent",
  },
};

// Phones (docs/ticket-mobile-pwa.md §5.5). viewport-fit=cover lets the app draw
// under the notch / home indicator — the mobile shell pads with safe-area
// insets. resizes-content shrinks the layout when the on-screen keyboard opens
// (Chrome/Android; iOS ignores it — page.tsx handles that via visualViewport).
// No effect on desktop browsers.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  // A single tag, NOT keyed to prefers-color-scheme: the app's theme is its own
  // state (page.tsx), which updates this tag when it changes. Two media-keyed
  // tags made the installed PWA's title bar follow the OS theme instead.
  themeColor: "#0a0a0a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${kaushan.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}

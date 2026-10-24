import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "QuantDesk — Multi-Broker Trading Terminal",
  description:
    "Multi-broker trading terminal (Sim Feed, Dhan, Shoonya, ICICI Breeze) with copy trading, capital sizing house rules, from-scratch charting and a Python strategy builder.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Installed BEFORE hydration so extension-origin errors (MetaMask injects
  // inpage.js into every page/iframe and throws "Failed to connect to
  // MetaMask" inside cross-origin preview iframes) never surface as app
  // errors in the console / preview error panel. App errors are untouched.
  const extNoiseGuard = `
(function(){
  try {
    var EXT = /inpage\\.js|chrome-extension:|moz-extension:|safari-extension:|metamask|content-script/i;
    function fromExtension(msg, src, stack) {
      try {
        var hay = (msg || '') + ' ' + (src || '') + ' ' + (stack || '');
        if (EXT.test(hay)) return true;
        // unhandled promise rejections carry no filename — reason often does
        return /MetaMask|ethereum|walletconnect/i.test(msg || '');
      } catch { return false; }
    }
    window.addEventListener('error', function (e) {
      if (fromExtension(e.message, e.filename, e.error && e.error.stack)) {
        e.preventDefault();
        console.info('[qd] suppressed browser-extension error (not from the app):', e.message);
      }
    }, true);
    window.addEventListener('unhandledrejection', function (e) {
      var r = e.reason;
      var msg = r && (r.message || String(r));
      var stack = r && r.stack;
      if (fromExtension(msg, '', stack)) e.preventDefault();
    });
  } catch { /* never break the app over a guard */ }
})();`
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: extNoiseGuard }} />
      </head>
      <body
        suppressHydrationWarning
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground h-screen overflow-hidden`}
      >
        {children}
        <SonnerToaster />
        <Toaster />
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Toaster } from "sonner";
import { TRPCReactProvider } from "@/components/trpc-provider";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "FinOpenPOS",
  description: "Open-source point of sale system",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning on <html> and <body> silences the noisy
    // "tree hydrated but some attributes didn't match" error caused by
    // browser extensions (password managers, privacy plugins) that inject
    // attributes like __processed_* or bis_register into <body> before
    // React hydrates. Only suppresses warnings on these two roots, not
    // on app components.
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className} suppressHydrationWarning>
        <TRPCReactProvider>
          <main>{children}</main>
          <Toaster richColors position="bottom-right" />
        </TRPCReactProvider>
      </body>
    </html>
  );
}

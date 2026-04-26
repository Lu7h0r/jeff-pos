import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Toaster } from "sonner";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { TRPCReactProvider } from "@/components/trpc-provider";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "FinOpenPOS",
  description: "Open-source point of sale system",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    // suppressHydrationWarning on <html> and <body> silences the noisy
    // "tree hydrated but some attributes didn't match" error caused by
    // browser extensions (password managers, privacy plugins) that inject
    // attributes like __processed_* or bis_register into <body> before
    // React hydrates. Only suppresses warnings on these two roots, not
    // on app components.
    <html lang="es-CO" suppressHydrationWarning>
      <body className={inter.className} suppressHydrationWarning>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <TRPCReactProvider>
            <main>{children}</main>
            <Toaster richColors position="bottom-right" />
          </TRPCReactProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

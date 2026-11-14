import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "AttendFlow — Workforce operations", description: "A secure, auditable workspace for attendance and workforce operations." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }

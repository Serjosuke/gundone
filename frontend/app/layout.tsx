import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Fenetraur",
  description: "Интерактивная карта и энциклопедия мира Фенетраура",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}

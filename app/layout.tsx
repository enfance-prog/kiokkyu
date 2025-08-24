export const metadata = {
  title: "おぼえるくん - リスト管理BOT",
  description: "LINEでリスト管理ができるBOT",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}

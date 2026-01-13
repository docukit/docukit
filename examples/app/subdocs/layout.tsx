import ClientLayout from "./ClientLayout";

export default function SubdocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <h1 className="p-4 text-2xl font-bold text-white">Subdocs Example</h1>
      <ClientLayout>{children}</ClientLayout>
    </>
  );
}

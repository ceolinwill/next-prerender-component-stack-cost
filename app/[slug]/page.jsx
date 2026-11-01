import { connection } from 'next/server';
import { Suspense } from 'react';

export function generateStaticParams() {
  return Array.from({ length: 400 }, (_, i) => ({ slug: `page-${i}` }));
}

// With HOLES=0 the same tree renders fully static, for comparison.
async function DynamicPart({ index }) {
  if (process.env.HOLES !== '0') await connection();
  return <p>Request-time part {index}</p>;
}

export default async function Page({ params }) {
  const { slug } = await params;
  return (
    <main>
      <h1>{slug}</h1>
      {[0, 1, 2, 3, 4].map((index) => (
        <Suspense key={index} fallback={<p>Loading part {index}…</p>}>
          <DynamicPart index={index} />
        </Suspense>
      ))}
    </main>
  );
}

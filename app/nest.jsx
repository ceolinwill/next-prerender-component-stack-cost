'use client';

import { createContext, useContext } from 'react';

const DepthContext = createContext(0);

// Stands in for the providers and layout wrappers a real app nests around
// its pages: every level is one more client component in the component stack.
export function Nest({ depth, children }) {
  const level = useContext(DepthContext);
  if (depth === 0) return children;
  return (
    <DepthContext value={level + 1}>
      <div data-level={level}>
        <Nest depth={depth - 1}>{children}</Nest>
      </div>
    </DepthContext>
  );
}

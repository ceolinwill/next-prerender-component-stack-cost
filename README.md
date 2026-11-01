# next-prerender-component-stack-cost

> [!NOTE]
> 🤖 **Claude Opus 5.5 made this reproduction on behalf of Will**

Reported upstream in [vercel/next.js#101014](https://github.com/vercel/next.js/issues/101014).

With `cacheComponents: true`, `next build` spends a large share of its static-generation CPU rebuilding React component stacks that are thrown away. For every dynamic hole (a `<Suspense>`-wrapped component that reads request data), the prerender's `onError` reads `errorInfo.componentStack` to classify the hole. In production React has no component frame cache, so every read re-runs every component above the hole with a throwing dispatcher and formats an `Error` stack per frame. Next.js only runs a few regexes over that text (is there a `Suspense`, an outlet, metadata or viewport boundary above the hole?), and for a hole inside `<Suspense>` the text is then dropped. In an app with ~1,150 prerendered pages this was about 23% of the build workers' CPU; in this reproduction it is about half.

## Reproduction

```sh
npm install
npm run profile
```

The app is one route, `app/[slug]/page.jsx`, with 400 static params. Each page has five `<Suspense>` boundaries around a component that calls `await connection()`, so every prerender hits five dynamic holes. The root layout wraps the page in 25 nested client components (`app/nest.jsx`), standing in for the providers and layout wrappers of a real app. `HOLES=0` renders the same tree without awaiting `connection()`, so the pages are fully static.

`npm run profile` builds twice, `HOLES=1` and `HOLES=0`, with Node's CPU profiler in every process, then reads the build workers' profiles and prints their CPU time, the share spent under React's `DetermineComponentFrameRoot`, and where it is called from. Output on Next.js 16.5.0-canary.36 (build logs omitted):

```
Static generation workers (CPU from Node --cpu-prof, idle excluded)

build          workers  worker CPU  under DetermineComponentFrameRoot  share
with holes     4        7132 ms     4139 ms                            58.0%
without holes  4        2314 ms     3 ms                               0.1%

Callers of DetermineComponentFrameRoot (with holes), innermost first:

  100.0%  nX (app-page-turbo.runtime.prod.js:2:76362) <- e (app-page-turbo.runtime.prod.js:2:83162) <- get (app-page-turbo.runtime.prod.js:2:83126) <- onError (app-page-turbo.runtime.prod.js:324:20738)

Self time under DetermineComponentFrameRoot (with holes), share of all worker CPU:

   18.0%  nV (app-page-turbo.runtime.prod.js:2:76005)
   15.1%  DetermineComponentFrameRoot (app-page-turbo.runtime.prod.js:2:76497)
    8.8%  a ([root-of-the-server]__02d5yvxht9-ts._.js:1:136)
    2.3%  (anonymous) (node_modules_next_dist_0x0pu0r_k-xrs._.js:1:21528)
    1.8%  il (app-page-turbo.runtime.prod.js:257:3150)
    1.2%  set (app-page-turbo.runtime.prod.js:2:76600)
```

What the minified names are (the React and Next.js frames are in `next/dist/compiled/next-server/app-page-turbo.runtime.prod.js`):

- `onError`: the final client prerender's `onError` in `prerenderToStream`.
- `get`: the lazy `componentStack` getter React puts on `errorInfo`.
- `nX`: React's `describeNativeComponentFrame`; `DetermineComponentFrameRoot` is the function it uses to call the component.
- `nV`: the `Error.prepareStackTrace` override `describeNativeComponentFrame` installs while it runs.
- `a`: the repro's `Nest` component; `(anonymous)` and `F` are Next's `OuterLayoutRouter` and `InnerLayoutRouter`, re-run for the same reason.

A fresh clone gave 58.5% with holes and 0.1% without. Across runs on a shared 16-core Mac the share with holes was 43% to 58.5%, lower when the machine was busier; total CPU varies with load, so compare the shares. The few ms without holes are the `/[slug]` fallback shell, which still has holes because its params are unknown. The latest stable release, `16.4.3`, gives the same result (58.0% with holes, 0.1% without).

## Expected

A dynamic hole inside `<Suspense>` is expected, not an error, so classifying it should cost little next to rendering the page. Pages with holes should take roughly the CPU they take without them.

## Actual

With holes, worker CPU is about 3x higher, and about half of it runs under `DetermineComponentFrameRoot`, called from Next's `onError`. Without that time, the run above would have used about 2.9 s instead of 6.9 s, close to the 2.4 s without holes.

Where it happens in `next@16.5.0-canary.36`:

- `dist/server/app-render/app-render.js`: each prerender `onError` checks `isPrerenderInterruptedError(err) || signal.aborted`, then reads `errorInfo.componentStack` (lines 4281, 4550, 5827 and 6214) and passes it to `trackDynamicHoleInStaticShell`, `trackDynamicAccessInStaticRoute`, `trackAllowedDynamicAccess` or `trackDynamicHoleInNavigation`. The profiled handler is the one at line 5827 (`prerenderToStream`), which calls `trackAllowedDynamicAccess`.
- `dist/server/app-render/dynamic-rendering-validation.js`: those functions only test the text against `hasOutletRegex`, `hasMetadataRegex`, `hasViewportRegex`, `hasSuspenseBeforeRootLayoutWithoutBodyOrImplicitBodyRegex` and `hasSuspenseRegex` (lines 102-121). They need component names, not source locations. When `hasSuspenseRegex` matches, `trackAllowedDynamicAccess` only sets `hasAllowedDynamic = true`; the stack is used again only to build an error message for a hole that fails validation.
- React's `describeNativeComponentFrame` (`packages/shared/ReactComponentStackFrame.js`) keeps its `componentFrameCache` in `__DEV__` only. In production every read calls each component in the stack again inside `DetermineComponentFrameRoot` and formats the thrown errors through a custom `Error.prepareStackTrace`. The same components sit above every hole on every page, so the same frames are rebuilt thousands of times.

`16.4.3` has the same handlers (lines 4309, 4578, 5821 and 6205 of the same file); in the source they are the `onError` handlers in `packages/next/src/server/app-render/app-render.tsx` that call the functions above.

## Environment

```
Operating System:
  Platform: darwin
  Arch: arm64
  Version: Darwin Kernel Version 27.2.0: Wed Oct 14 23:44:56 PDT 2026; root:xnu-13432.41.4~25/RELEASE_ARM64_T6041
  Available memory (MB): 65536
  Available CPU cores: 16
Binaries:
  Node: 24.22.0
  npm: 11.19.1
  Yarn: N/A
  pnpm: 12.4.0
Relevant Packages:
  next: 16.5.0-canary.36 // Latest available version is detected (16.5.0-canary.36).
  eslint-config-next: N/A
  react: 19.3.1
  react-dom: 19.3.1
  typescript: N/A
Next.js Config:
  output: N/A
  cacheComponents: true
```

Builds use Turbopack (the default).

## How the profile is taken

`next build --experimental-cpu-prof` saves only the main process's profile: the build workers save theirs on exit, and Next ends them with `SIGINT`. `scripts/profile.mjs` instead sets `NODE_OPTIONS="--require scripts/sigint-exit.cjs --cpu-prof --cpu-prof-dir=profiles/<run>"`. The preload turns `SIGINT` into a normal exit so Node writes each worker's profile. The script then waits for every process in the build's process group to exit before reading the profiles, and keeps those from processes that ran `next/dist/export/worker.js`. It needs a POSIX shell environment (macOS or Linux).

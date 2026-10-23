declare module 'virtual:flue/server' {
  export function startFlueNodeServer(
    options?: import('@flue/vite').StartFlueNodeServerOptions,
  ): Promise<import('@flue/vite').FlueNodeServer>;
}

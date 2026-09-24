import ts from 'typescript';

type TransformResult = {
  readonly code: string;
  readonly map: string | undefined;
};

/**
 * Transform TypeScript tests with decorator metadata without an extra
 * compiler dependency.
 *
 * @returns A Vite plugin for Vitest's TypeScript source transform.
 */
export function typescriptDecoratorTransform(): {
  readonly name: string;
  readonly enforce: 'pre';
  transform(code: string, id: string): TransformResult | undefined;
} {
  return {
    name: 'kefu-typescript-decorator-transform',
    enforce: 'pre',
    transform(source: string, id: string): TransformResult | undefined {
      if (!/\.(?:ts|tsx)$/.test(id) || id.includes('/node_modules/')) {
        return undefined;
      }

      const result = ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Node10,
          sourceMap: true,
          inlineSources: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          jsx: ts.JsxEmit.ReactJSX,
        },
        fileName: id,
        reportDiagnostics: false,
      });
      const sourceMap = result.sourceMapText
        ? (JSON.parse(result.sourceMapText) as { sources?: string[] })
        : undefined;

      return {
        code: result.outputText,
        map: sourceMap === undefined ? undefined : JSON.stringify(sourceMap),
      };
    },
  };
}

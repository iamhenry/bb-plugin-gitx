import { experimental_Diff } from "@get-bb/plugin-sdk/app";

const Diff = experimental_Diff;

/** Single wrapper around the host experimental diff APIs. */
export function GitDiff({
  path,
  patch,
  oldContent,
  newContent,
  view,
}: {
  path: string;
  patch: string;
  oldContent: string;
  newContent: string;
  view: "unified" | "split";
}) {
  return (
    <Diff
      path={path}
      patch={patch}
      view={view}
      experimental_fullFileContents={{
        old: { path, content: oldContent },
        new: { path, content: newContent },
      }}
    />
  );
}

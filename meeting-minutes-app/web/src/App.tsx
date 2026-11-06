import { Mic } from "lucide-react";
import { JobPage } from "./pages/JobPage";
import { UploadPage } from "./pages/UploadPage";
import { matchJobPath, useRoute } from "./lib/router";

export function App() {
  const { path, navigate } = useRoute();
  const jobId = matchJobPath(path);

  return (
    <div className="min-h-dvh">
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate("/");
            }}
            className="flex items-center gap-2 text-[15px] font-extrabold tracking-tight text-slate-900"
          >
            <span className="grid size-7 place-items-center rounded-lg bg-indigo-600 text-white">
              <Mic className="size-4" aria-hidden />
            </span>
            회의록 AI
          </a>
          {jobId && (
            <a
              href="/"
              onClick={(e) => {
                e.preventDefault();
                navigate("/");
              }}
              className="inline-flex min-h-10 items-center rounded-lg px-3 text-sm font-semibold text-indigo-700 hover:bg-indigo-50"
            >
              새 회의록
            </a>
          )}
        </div>
      </header>
      <main>{jobId ? <JobPage key={jobId} id={jobId.toLowerCase()} navigate={navigate} /> : <UploadPage navigate={navigate} />}</main>
    </div>
  );
}

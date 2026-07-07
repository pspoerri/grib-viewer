/** Format a run id (`YYYYMMDDTHHMMSSZ`) as `YYYY-MM-DD HH:MMZ`. Returns
 *  the input unchanged when it doesn't match the run-id shape. Pure utility
 *  (moved off the retired v1 REST client module). */
export function formatRunLabel(runID: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})\d{2}Z$/.exec(runID);
  if (!m) return runID;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}Z`;
}

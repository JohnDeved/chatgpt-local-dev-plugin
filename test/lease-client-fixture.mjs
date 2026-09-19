import { ProjectLeases } from "../dist/project-leases.js";
const provider = new ProjectLeases(process.argv[2]);
let serial = Promise.resolve();
process.on("message", message => {
  serial = serial.then(async () => {
    try {
      let value;
      if (message.action === "open") {
        const provisional = await provider.reserve(message.session, message.path, message.options, message.previous);
        try { value = await provider.commit(message.session, provisional.generation, message.previous, message.options.handoffId); }
        catch (error) { await provider.abort(message.session, provisional.generation); throw error; }
      } else if (message.action === "reserve") value = await provider.reserve(message.session, message.path, message.options, message.previous);
      else if (message.action === "commit") value = await provider.commit(message.session, message.generation, message.previous, message.handoffId);
      else if (message.action === "abort") value = await provider.abort(message.session, message.generation);
      else if (message.action === "background-exited") value = await provider.backgroundExited(message.session, message.generation, message.operation, message.pid);
      else if (message.action === "close-provider") value = await provider.close();
      else if (message.action === "close") {
        await provider.close(); process.send({ sequence: message.sequence, ok: true }); process.disconnect(); return;
      } else if (message.action === "exit-with-lease") {
        // The fixture voluntarily exits without release; no external process is killed.
        process.send({ sequence: message.sequence, ok: true }); process.exit(0);
      } else if (message.action === "release") value = await provider.release(message.session, message.generation);
      else if (message.action === "access") value = await provider.access(message.session, message.generation, message.write);
      else if (message.action === "complete") value = await provider.complete(message.session, message.generation, message.operation, message.background);
      else if (message.action === "force") value = await provider.forceRelease(message.session, message.path, message.generation, message.reason);
      else if (message.action === "handoff") value = await provider.handoff(message.id);
      else throw new Error("UNKNOWN_FIXTURE_ACTION");
      process.send({ sequence: message.sequence, ok: true, value });
    } catch (error) { process.send({ sequence: message.sequence, ok: false, code: error.code ?? error.message, detail: error.detail ?? null }); }
  });
});
process.send({ ready: true, pid: process.pid });

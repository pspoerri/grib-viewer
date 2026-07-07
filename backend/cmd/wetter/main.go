// wetter: standalone NWP GRIB viewer (specs in docs/specs/).
//
//	wetter serve --config wetter.yaml [--fetch]   HTTP API (+ fetch loops with --fetch)
//	wetter fetch --config wetter.yaml [--once] [--source id]
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/pspoerri/wetter/internal/api"
	"github.com/pspoerri/wetter/internal/buffer"
	"github.com/pspoerri/wetter/internal/config"
	"github.com/pspoerri/wetter/internal/engine"
	"github.com/pspoerri/wetter/internal/sources"
	"github.com/pspoerri/wetter/internal/webui"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: wetter serve|fetch --config wetter.yaml")
		os.Exit(2)
	}
	cmd := os.Args[1]
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	cfgPath := fs.String("config", "wetter.yaml", "config file")
	once := fs.Bool("once", false, "fetch: single pass, then exit")
	sourceID := fs.String("source", "", "fetch/bench: only this source")
	addr := fs.String("addr", "", "serve: listen address override")
	fetchLoops := fs.Bool("fetch", false, "serve: run the fetch loops in-process")
	noFetch := fs.Bool("no-fetch", false, "bench: reuse the existing buffer")
	fs.Parse(os.Args[2:])

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		fatal(err)
	}
	if *addr != "" {
		cfg.Listen = *addr
	}
	buf := buffer.New(cfg.DataDir)
	orch, err := sources.NewOrchestrator(buf, cfg.Sources)
	if err != nil {
		fatal(err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch cmd {
	case "fetch":
		if *sourceID != "" {
			if err := orch.RunOnce(ctx, *sourceID); err != nil {
				fatal(err)
			}
			return
		}
		if *once {
			for _, s := range cfg.Sources {
				if s.Fetch == "off" {
					continue
				}
				if err := orch.RunOnce(ctx, s.ID); err != nil {
					slog.Error("fetch", "source", s.ID, "err", err)
				}
			}
			return
		}
		orch.Run(ctx)

	case "serve":
		eng := engine.New(buf, cfg.Cache.FieldsMB)
		// downloads are opt-in: by default serve only reads the
		// existing buffer; run `wetter fetch` separately or pass --fetch
		if *fetchLoops {
			go orch.Run(ctx)
			go func() {
				for id := range orch.Changed() {
					eng.InvalidateSource(id)
				}
			}()
		}
		srv := api.New(eng, cfg, func() any { return orch.Status() })
		if static := webui.Handler(); static != nil {
			srv.Static = static
			slog.Info("serving embedded frontend at /")
		}
		hs := &http.Server{Addr: cfg.Listen, Handler: srv.Handler()}
		go func() {
			<-ctx.Done()
			hs.Shutdown(context.Background())
		}()
		slog.Info("wetter serve", "addr", cfg.Listen, "data_dir", cfg.DataDir)
		if err := hs.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			fatal(err)
		}

	case "bench":
		if err := runBench(ctx, cfg, *sourceID, *noFetch); err != nil {
			fatal(err)
		}

	default:
		fatal(fmt.Errorf("unknown command %q", cmd))
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "wetter:", err)
	os.Exit(1)
}

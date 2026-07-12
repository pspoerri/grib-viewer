package gribidx

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	grib "github.com/pspoerri/go-tiled-eccodes"
)

func TestSaveLoadRunLocalPathSurvivesMove(t *testing.T) {
	oldParent := t.TempDir()
	oldRun := filepath.Join(oldParent, "run")
	if err := os.Mkdir(oldRun, 0o755); err != nil {
		t.Fatal(err)
	}
	oldFile := filepath.Join(oldRun, "field.grib2")
	if err := os.WriteFile(oldFile, []byte("GRIB"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Save(oldRun, &RunIndex{Files: []FileEntry{{Path: oldFile}}}); err != nil {
		t.Fatal(err)
	}

	newRun := filepath.Join(t.TempDir(), "run")
	if err := os.Rename(oldRun, newRun); err != nil {
		t.Fatal(err)
	}
	got, err := Load(newRun)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(newRun, "field.grib2")
	if got.Files[0].Path != want {
		t.Fatalf("Path = %q, want %q", got.Files[0].Path, want)
	}
}

func TestLoadRecoversLegacyAbsoluteRunLocalPath(t *testing.T) {
	runDir := t.TempDir()
	file := filepath.Join(runDir, "field.grib2")
	if err := os.WriteFile(file, []byte("GRIB"), 0o600); err != nil {
		t.Fatal(err)
	}
	doc := RunIndex{Files: []FileEntry{{Path: filepath.Join("/old/data/run", filepath.Base(file))}}}
	raw, err := json.Marshal(&doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runDir, IndexFile), raw, 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := Load(runDir)
	if err != nil {
		t.Fatal(err)
	}
	if got.Files[0].Path != file {
		t.Fatalf("Path = %q, want %q", got.Files[0].Path, file)
	}
}

func TestEnsembleMemberRequiresConsistentDeclaration(t *testing.T) {
	declared := 0
	member, size, err := ensembleMember(grib.Header{
		TypeOfEnsembleForecast:      0,
		PerturbationNumber:          0,
		NumberOfForecastsInEnsemble: 11,
	}, &declared)
	if err != nil || member != 0 || size != 11 || declared != 11 {
		t.Fatalf("first member = (%d, %d, %v), declared %d", member, size, err, declared)
	}
	_, _, err = ensembleMember(grib.Header{
		TypeOfEnsembleForecast:      3,
		PerturbationNumber:          1,
		NumberOfForecastsInEnsemble: 10,
	}, &declared)
	if err == nil {
		t.Fatal("inconsistent declaration returned nil error")
	}
}

func TestValidateMergedEnsembles(t *testing.T) {
	valid := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	messages := func(first, last, declared int) []Msg {
		out := make([]Msg, 0, last-first+1)
		for member := first; member <= last; member++ {
			out = append(out, Msg{
				Var:          "t_2m",
				LevelType:    103,
				Level:        2,
				Member:       member,
				EnsembleSize: declared,
				Ref:          valid.Add(-time.Hour),
				Valid:        valid,
			})
		}
		return out
	}

	t.Run("DWD single 40-member file", func(t *testing.T) {
		files := []FileEntry{{Path: "dwd.grib2", Msgs: messages(1, 40, 40)}}
		if err := validateMergedEnsembles(files); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("MeteoSwiss split control and perturbed assets", func(t *testing.T) {
		files := []FileEntry{
			{Path: "ctrl.grib2", Msgs: messages(0, 0, 11)},
			{Path: "pert.grib2", Msgs: messages(1, 10, 11)},
		}
		if err := validateMergedEnsembles(files); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("incomplete merged set", func(t *testing.T) {
		files := []FileEntry{
			{Path: "ctrl.grib2", Msgs: messages(0, 0, 11)},
			{Path: "pert.grib2", Msgs: messages(1, 9, 11)},
		}
		err := validateMergedEnsembles(files)
		if err == nil || !strings.Contains(err.Error(), "10 merged members, declared 11") {
			t.Fatalf("error = %v", err)
		}
	})

	t.Run("conflicting declarations", func(t *testing.T) {
		files := []FileEntry{
			{Path: "ctrl.grib2", Msgs: messages(0, 0, 11)},
			{Path: "pert.grib2", Msgs: messages(1, 10, 10)},
		}
		err := validateMergedEnsembles(files)
		if err == nil || !strings.Contains(err.Error(), "conflicting member counts") {
			t.Fatalf("error = %v", err)
		}
	})
}

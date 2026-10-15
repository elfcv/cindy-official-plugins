package main

import (
	"fmt"
	"os"
	"os/exec"
)

func browserParent() error {
	// Dynamic validation uses the kernel process identity, not argv/ps paths.
	requirement := `anchor apple generic and ((certificate leaf[subject.OU] = "EQHXZ8M8AV" and (identifier "com.google.Chrome" or identifier "com.google.Chrome.forTesting")) or (certificate leaf[subject.OU] = "UBF8T346G9" and identifier "com.microsoft.edgemac") or (certificate leaf[subject.OU] = "KL8N8XSYF4" and identifier "com.brave.Browser"))`
	cmd := exec.Command("/usr/bin/codesign", "--verify", "-R", "="+requirement, fmt.Sprint(os.Getppid()))
	return cmd.Run()
}

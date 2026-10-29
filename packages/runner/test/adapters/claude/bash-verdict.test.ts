import { describe, expect, test } from 'bun:test';
import { bashVerdict } from '../../../src/adapters/claude/bash-verdict';

const GIT_WRITE = 'writing into .git/hooks or .git/config is refused';

function reason(command: string): string {
  const verdict = bashVerdict(command);
  if (verdict.allow) throw new Error(`expected ${JSON.stringify(command)} to be refused`);
  return verdict.reason;
}

describe('bashVerdict', () => {
  test('a computed git subcommand is refused, including the real-CLI push bypasses', () => {
    for (const command of [
      'v=push; git "$v"',
      'git "$(printf push)"',
      'git `printf push`',
      'git -C "$repo" "${verb}"',
      'v=push; eval "git $v"',
      'sh -c \'v=push; git "$v"\'',
    ]) {
      expect({ command, verdict: bashVerdict(command) }).toEqual({
        command,
        verdict: { allow: false, reason: expect.stringMatching(/git subcommand .* is computed when it runs/) },
      });
    }
    // Computed data does not select the git operation and remains usable.
    expect(bashVerdict('git -C "$repo" status')).toEqual({ allow: true });
    expect(bashVerdict('git log --format="$format"')).toEqual({ allow: true });
  });

  test('git push is refused however it is spelled or wrapped', () => {
    const pushes = [
      'git push',
      'git push origin HEAD:main --force',
      'git -C . push',
      'git -c k=v push',
      'git --git-dir=x push',
      'git --git-dir x --work-tree y push',
      'git --no-pager -P push',
      '/usr/bin/git push',
      '\\git push',
      '"git" "push"',
      'env A=1 git push',
      'env -i -u HOME PATH=/bin git push',
      'env -S "git push"',
      'A=1 B=2 git push',
      'command git push',
      'command -p git push',
      'builtin exec git push',
      'nohup nice -n 5 timeout -s KILL 10 git push',
      'time -p git push',
      'sudo -u me git push',
      'xargs -I {} git push',
      'cd x && git push',
      'git status; git push',
      'true || git push',
      'ls | git push',
      '(git push)',
      '{ git push; }',
      'if true; then git push; fi',
      'for b in a; do git push; done',
      '! git push',
      'echo $(git push)',
      'echo "$(git push)"',
      'echo `git push`',
      'A=$(git push)',
      'cat <(git push)',
      'bash -c "git push"',
      "bash -c 'git push'",
      'sh -c "git -C . push"',
      'zsh -lc "cd x; git push"',
      'bash -o pipefail -c "git push"',
      'sh -c "sh -c \\"git push\\""',
      'eval git push',
      "eval 'git' push",
      'find . -name x -exec git push \\;',
      'git send-pack origin',
      'git-push origin',
      'git -c alias.p=push p',
      'cat <<EOF\n$(git push)\nEOF',
      "$'\\x67it' push",
      "$'\\147it' push",
      "$'\\u0067it' push",
      'git --config-env=alias.p=X p',
      'git http-push origin',
      'bash --rcfile x -c "git push"',
      'find . -execdir git push \\;',
      'find . -ok git push \\;',
      // Ways of handing a shell its script.
      "bash -c -- 'git push'",
      "sh -c - 'git push'",
      "bash -O extglob -c 'git push'",
      "bash +O extglob -c 'git push'",
      "bash <<'EOF'\ngit push\nEOF",
      'sh -s <<EOF\ngit push\nEOF',
      "bash <<< 'git push'",
      // Keywords before the command, and zsh's precommand modifiers.
      'function f { git push; }; f',
      'coproc git push',
      'coproc P { git push; }',
      'noglob git push',
      'nocorrect git push',
      '- git push',
      '=git push',
      'repeat 2 git push',
      'repeat 2 do git push; done',
      // Names that a case-insensitive volume finds as git, env and bash.
      'Git push',
      'GIT push',
      'ENV git push',
      `BASH -c 'git push'`,
      // Commands git runs itself, and aliases.
      'git config alias.p push && git p',
      'git rebase -x "git push" HEAD~1',
      'git rebase --exec="git push" HEAD~1',
      'git bisect run git push',
      'git submodule foreach git push',
      "git submodule --quiet foreach --recursive 'git push'",
      'git subtree push --prefix=lib origin main',
    ];
    for (const command of pushes) {
      expect({ command, reason: reason(command) }).toEqual({ command, reason: expect.stringMatching(/push/) });
    }
  });

  test('git credential, git config --global, gh, glab and security are refused', () => {
    expect(reason('git credential fill')).toMatch(/git credential/);
    expect(reason('git credential-osxkeychain get')).toMatch(/git credential/);
    expect(reason('printf "protocol=https\\n" | git -C /x credential fill')).toMatch(/git credential/);
    expect(reason('git config --global user.email a@b')).toMatch(/--global/);
    expect(reason('git config set --global core.editor vi')).toMatch(/--global/);
    expect(reason('gh pr create')).toMatch(/\bgh\b/);
    expect(reason('gh')).toMatch(/\bgh\b/);
    expect(reason('/opt/homebrew/bin/glab mr list')).toMatch(/glab/);
    expect(reason('security find-generic-password -s x')).toMatch(/security/);
    expect(reason('env security dump-keychain')).toMatch(/security/);
    expect(reason('GH pr create')).toMatch(/\bgh\b/);
    expect(reason('SECURITY find-generic-password -s x')).toMatch(/security/);
  });

  test('writes into .git/hooks and .git/config are refused', () => {
    const writes = [
      'echo x > .git/config',
      'echo x >> .git/hooks/pre-commit',
      'echo x 2> ./.git/config',
      'echo x &> sub/.git/hooks/post-checkout',
      'printf x >| .git//config',
      '> .git/config',
      'cat a > .git/hooks/x/../pre-push',
      'cp evil .git/hooks/pre-commit',
      'cp -r myhooks .git/hooks',
      'cp config .git/',
      'cp -t .git/hooks evil',
      'mv evil .git/hooks/pre-commit',
      'ln -sf ../../evil .git/hooks/pre-commit',
      'install -m 755 evil .git/hooks/pre-commit',
      'echo x | tee -a .git/config',
      'tee .git/hooks/pre-push < x',
      'sed -i "" "s/a/b/" .git/config',
      'sed -i.bak -e s/a/b/ .git/config',
      'sed --in-place s/a/b/ .git/config',
      'cp x .git/hoo*',
      'cd x && (echo y > .git/config)',
      'echo x >& .git/config',
      'cp -t.git/hooks evil',
      'cp --target-directory=.git/hooks evil',
      'sed -ni s/a/b/ .git/config',
      // Case-insensitive volumes find these as .git/hooks, .git/config and .git.
      'cp evil .git/Hooks/pre-commit',
      'echo x >> .GIT/CONFIG',
      'mkdir -p .git/HOOKS && tee .git/HOOKS/pre-push < evil',
      'ln -s ../.g .GIT',
    ];
    for (const command of writes) {
      expect({ command, reason: reason(command) }).toEqual({ command, reason: GIT_WRITE });
    }
  });

  test('ordinary commands are allowed', () => {
    const allowed = [
      'git commit -m "push later"',
      'git log --grep=push',
      'echo "git push"',
      "echo 'gh pr create' > notes.txt",
      'git status',
      'git config user.name x',
      'git config --get remote.origin.url',
      'git -C sub log',
      'grep -r security src',
      'bun test',
      'bun install && bun run build 2>&1 | tail -20',
      'cat .git/config',
      'cp .git/hooks/pre-commit.sample /tmp/x',
      'sed "s/a/b/" .git/config > out',
      'ls .git/hooks',
      'command -v gh',
      'env',
      'env | grep PATH',
      'git commit -F - <<EOF\nNo gh, no push\nEOF',
      `git commit -m "$(cat <<'EOF'\nDon't push yet; gh comes later\nEOF\n)"`,
      'bash scripts/build.sh',
      'echo $HOME > out.txt',
      '$HOME/.bun/bin/bun test',
      'function f { ls; }; f',
      'noglob ls *.ts',
      'git rebase -x "bun test" main',
      'git bisect run bun test',
      'git submodule foreach git status',
      'git config --get remote.origin.url',
      'bash <<EOF\nbun test\nEOF',
      'bash script.sh <<EOF\ngit push\nEOF',
    ];
    for (const command of allowed) {
      expect({ command, verdict: bashVerdict(command) }).toEqual({ command, verdict: { allow: true } });
    }
  });

  test('a command that cannot be parsed is refused with the reason', () => {
    expect(reason('echo "unbalanced')).toBe(
      'the command cannot be parsed (unterminated double quote), so it is refused',
    );
    expect(reason('bash -c "echo \'x"')).toMatch(/cannot be parsed \(unterminated single quote\)/);
    expect(reason('bash -c')).toMatch(/cannot be parsed/);
    expect(reason('env -Z git push')).toMatch(/cannot be parsed/);
    expect(reason(`${'eval '.repeat(20)}ls`)).toBe(
      'the command cannot be parsed (shells nested too deeply), so it is refused',
    );
    // A command name computed when the command runs cannot be judged, git push or not.
    const computed = [
      "sh -c '$1' _ 'git push'",
      `sh -c '"$@"' _ git push`,
      `eval "$(printf 'git push')"`,
      'g=git; $g push',
      '$(echo git) push',
      '`echo git` push',
      '$EDITOR notes.txt',
    ];
    for (const command of computed) {
      expect({ command, reason: reason(command) }).toEqual({
        command,
        reason: expect.stringMatching(/^the command cannot be parsed \(the command name .* is computed when it runs\)/),
      });
    }
    // Nesting far past the bound is refused, not a stack overflow.
    expect(reason(`git push; echo ${'"${'.repeat(20_000)}x${'}"'.repeat(20_000)}`)).toBe(
      'the command cannot be parsed (nested too deeply), so it is refused',
    );
  });
});

use crate::error::{Error, Result, parse_err};
use crate::fsutil::write_atomic;
use crate::keygen::generate_key;
use crate::model::*;
use crate::stagefile::is_valid_key;
use crate::status::cycle_for_link;
use std::path::{Path, PathBuf};

const CONFIG: &str = ".pathloom/project.toml";
const BOARD_SUFFIX: &str = ".board.json";

#[derive(Debug, Clone)]
pub struct Project {
    pub root: PathBuf,
    pub config: ProjectConfig,
}

fn read_text(path: &Path) -> Result<String> {
    Ok(std::fs::read_to_string(path)?)
}

fn check_board_name(name: &str) -> Result<()> {
    let bad = name.is_empty()
        || name.contains(['\\', ':'])
        || name.split('/').any(|s| s.is_empty() || s == "." || s == "..");
    if bad { Err(Error::InvalidName(name.into())) } else { Ok(()) }
}

fn check_key(key: &str) -> Result<()> {
    if is_valid_key(key) { Ok(()) } else { Err(Error::InvalidKey(key.into())) }
}

impl Project {
    /// Create `.pathloom/`, `plan/boards/roadmap.board.json` and `plan/stages/`.
    pub fn init(root: &Path, name: &str) -> Result<Project> {
        let cfg_path = root.join(CONFIG);
        if cfg_path.exists() {
            return Err(Error::AlreadyInitialized(root.to_path_buf()));
        }
        let config = ProjectConfig {
            format: 1,
            name: name.into(),
            plan_dir: "plan".into(),
            agent_changes: AgentChanges::Auto,
        };
        let text = toml::to_string(&config).map_err(|e| parse_err(&cfg_path, e))?;
        write_atomic(&cfg_path, text.as_bytes())?;
        write_atomic(&root.join(".pathloom/.gitignore"), b"cache/\nproposals/\nlog/\n")?;
        let p = Project { root: root.to_path_buf(), config };
        std::fs::create_dir_all(p.plan_dir().join("stages"))?;
        if !p.board_path("roadmap").exists() {
            p.save_board("roadmap", &Board::new("Roadmap"))?;
        }
        Ok(p)
    }

    pub fn open(root: &Path) -> Result<Project> {
        let path = root.join(CONFIG);
        if !path.is_file() {
            return Err(Error::NotAProject);
        }
        let config = toml::from_str(&read_text(&path)?).map_err(|e| parse_err(&path, e))?;
        Ok(Project { root: root.to_path_buf(), config })
    }

    /// Search `start` and its ancestors for a project.
    pub fn find(start: &Path) -> Result<Project> {
        start.ancestors().find(|d| d.join(CONFIG).is_file()).map_or(Err(Error::NotAProject), Project::open)
    }

    pub fn plan_dir(&self) -> PathBuf {
        self.root.join(&self.config.plan_dir)
    }

    fn board_path(&self, name: &str) -> PathBuf {
        self.plan_dir().join("boards").join(format!("{name}{BOARD_SUFFIX}"))
    }

    fn stage_path(&self, key: &str) -> PathBuf {
        self.plan_dir().join("stages").join(format!("{key}.md"))
    }

    // ---- boards ----

    pub fn list_boards(&self) -> Result<Vec<String>> {
        fn walk(dir: &Path, prefix: &str, out: &mut Vec<String>) -> Result<()> {
            let Ok(rd) = std::fs::read_dir(dir) else { return Ok(()) };
            for e in rd {
                let e = e?;
                let fname = e.file_name().to_string_lossy().into_owned();
                if e.file_type()?.is_dir() {
                    walk(&e.path(), &format!("{prefix}{fname}/"), out)?;
                } else if let Some(stem) = fname.strip_suffix(BOARD_SUFFIX) {
                    out.push(format!("{prefix}{stem}"));
                }
            }
            Ok(())
        }
        let mut out = Vec::new();
        walk(&self.plan_dir().join("boards"), "", &mut out)?;
        out.sort();
        Ok(out)
    }

    pub fn load_board(&self, name: &str) -> Result<Board> {
        check_board_name(name)?;
        let path = self.board_path(name);
        if !path.is_file() {
            return Err(Error::NotFound(format!("board {name}")));
        }
        Board::from_json(&path, &read_text(&path)?)
    }

    pub fn save_board(&self, name: &str, board: &Board) -> Result<()> {
        check_board_name(name)?;
        write_atomic(&self.board_path(name), board.to_canonical_json().as_bytes())
    }

    pub fn create_board(&self, name: &str, title: &str) -> Result<Board> {
        check_board_name(name)?;
        if self.board_path(name).exists() {
            return Err(Error::DuplicateKey(name.into()));
        }
        let b = Board::new(title);
        self.save_board(name, &b)?;
        Ok(b)
    }

    // ---- stages ----

    /// All stages, sorted by key.
    pub fn load_stages(&self) -> Result<Vec<Stage>> {
        let mut out = Vec::new();
        if let Ok(rd) = std::fs::read_dir(self.plan_dir().join("stages")) {
            for e in rd {
                let path = e?.path();
                if path.extension().is_some_and(|x| x == "md") {
                    out.push(Stage::from_markdown(&path, &read_text(&path)?)?);
                }
            }
        }
        out.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(out)
    }

    pub fn load_stage(&self, key: &str) -> Result<Stage> {
        check_key(key)?;
        let path = self.stage_path(key);
        if !path.is_file() {
            return Err(Error::NotFound(format!("stage {key}")));
        }
        Stage::from_markdown(&path, &read_text(&path)?)
    }

    pub fn save_stage(&self, stage: &Stage) -> Result<()> {
        check_key(&stage.key)?;
        write_atomic(&self.stage_path(&stage.key), stage.to_markdown().as_bytes())
    }

    /// `key`: explicit (validated, must be free) or generated from the title.
    pub fn create_stage(&self, title: &str, key: Option<&str>) -> Result<Stage> {
        let taken = |k: &str| self.stage_path(k).exists();
        let key = match key {
            Some(k) => {
                check_key(k)?;
                if taken(k) {
                    return Err(Error::DuplicateKey(k.into()));
                }
                k.to_string()
            }
            None => generate_key(title, &taken),
        };
        let stage = Stage::new(&key, title);
        self.save_stage(&stage)?;
        Ok(stage)
    }

    /// Deletes the file and removes `key` from other stages' `depends`.
    pub fn delete_stage(&self, key: &str) -> Result<()> {
        check_key(key)?;
        let path = self.stage_path(key);
        if !path.is_file() {
            return Err(Error::NotFound(format!("stage {key}")));
        }
        std::fs::remove_file(path)?;
        for mut s in self.load_stages()? {
            let before = s.depends.len();
            s.depends.retain(|d| d.id != key);
            if s.depends.len() != before {
                self.save_stage(&s)?;
            }
        }
        Ok(())
    }

    fn edit_stage(&self, key: &str, f: impl FnOnce(&mut Stage) -> Result<()>) -> Result<Stage> {
        let mut s = self.load_stage(key)?;
        f(&mut s)?;
        self.save_stage(&s)?;
        Ok(s)
    }

    pub fn add_task(&self, key: &str, title: &str) -> Result<Stage> {
        self.edit_stage(key, |s| {
            let prefix = format!("{key}-");
            let max = s
                .tasks
                .iter()
                .filter_map(|t| t.id.strip_prefix(&prefix)?.parse::<u32>().ok())
                .max()
                .unwrap_or(0);
            s.tasks.push(Task {
                id: format!("{prefix}{:02}", max + 1),
                title: title.trim().into(),
                done: false,
                sub: vec![],
            });
            Ok(())
        })
    }

    /// Renames a stage. The key (and file name) stays the same so links keep working.
    pub fn set_title(&self, key: &str, title: &str) -> Result<Stage> {
        let title = title.trim();
        if title.is_empty() {
            return Err(Error::InvalidName("stage title must not be empty".into()));
        }
        self.edit_stage(key, |s| {
            s.title = title.into();
            Ok(())
        })
    }

    /// Edit a task or subtask located by its id (`M0-02` or `M0-02a`).
    fn edit_task(&self, task_id: &str, f: impl FnOnce(&mut Vec<Task>, usize, Option<usize>)) -> Result<Stage> {
        let key = task_id.split('-').next().unwrap_or("");
        self.edit_stage(key, |s| {
            let pos = s.tasks.iter().enumerate().find_map(|(i, t)| {
                if t.id == task_id {
                    Some((i, None))
                } else {
                    t.sub.iter().position(|x| x.id == task_id).map(|j| (i, Some(j)))
                }
            });
            let (i, j) = pos.ok_or_else(|| Error::NotFound(format!("task {task_id}")))?;
            f(&mut s.tasks, i, j);
            Ok(())
        })
    }

    pub fn set_task_done(&self, task_id: &str, done: bool) -> Result<Stage> {
        self.edit_task(task_id, |tasks, i, j| {
            let t = &mut tasks[i];
            match j {
                Some(j) => t.sub[j].done = done,
                None => t.sub.iter_mut().for_each(|s| s.done = done),
            }
            t.done = if t.sub.is_empty() { done } else { t.sub.iter().all(|s| s.done) };
        })
    }

    pub fn rename_task(&self, task_id: &str, title: &str) -> Result<Stage> {
        self.edit_task(task_id, |tasks, i, j| match j {
            Some(j) => tasks[i].sub[j].title = title.trim().into(),
            None => tasks[i].title = title.trim().into(),
        })
    }

    pub fn remove_task(&self, task_id: &str) -> Result<Stage> {
        self.edit_task(task_id, |tasks, i, j| match j {
            Some(j) => {
                tasks[i].sub.remove(j);
            }
            None => {
                tasks.remove(i);
            }
        })
    }

    /// Add `from` to `to`'s depends. Self-link / cycle -> `Error::Cycle`; existing link is a no-op.
    pub fn link(&self, from: &str, to: &str, soft: bool) -> Result<()> {
        check_key(from)?;
        check_key(to)?;
        let stages = self.load_stages()?;
        for k in [from, to] {
            if !stages.iter().any(|s| s.key == k) {
                return Err(Error::NotFound(format!("stage {k}")));
            }
        }
        if let Some(cycle) = cycle_for_link(&stages, from, to) {
            return Err(Error::Cycle(cycle));
        }
        self.edit_stage(to, |s| {
            if s.depends.iter().all(|d| d.id != from) {
                s.depends.push(Dep { id: from.into(), soft });
            }
            Ok(())
        })
        .map(|_| ())
    }

    pub fn unlink(&self, from: &str, to: &str) -> Result<()> {
        self.edit_stage(to, |s| {
            s.depends.retain(|d| d.id != from);
            Ok(())
        })
        .map(|_| ())
    }
}

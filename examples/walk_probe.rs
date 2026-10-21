use std::time::Instant;

fn main() {
    let root = std::env::args().nth(1).expect("root arg");
    // 1. Raw ignore Walk iterator, count only
    for _ in 0..2 {
        let t = Instant::now();
        let mut n = 0usize;
        for e in ignore::Walk::new(&root) {
            if e.is_ok() {
                n += 1;
            }
        }
        println!("ignore::Walk count-only: {:?} n={}", t.elapsed(), n);
    }
    // 2. Raw ignore WalkParallel, count only
    for _ in 0..2 {
        let t = Instant::now();
        let count = std::sync::atomic::AtomicUsize::new(0);
        let walker = ignore::WalkBuilder::new(&root)
            .standard_filters(false)
            .hidden(true)
            .require_git(false)
            .build_parallel();
        walker.run(|| {
            let count = &count;
            Box::new(move |e| {
                if e.is_ok() {
                    count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
                ignore::WalkState::Continue
            })
        });
        println!(
            "ignore::WalkParallel count-only: {:?} n={}",
            t.elapsed(),
            count.load(std::sync::atomic::Ordering::Relaxed)
        );
    }
    // 3. std fs recursive walk, count only
    fn walk(p: &std::path::Path, n: &mut usize) {
        if let Ok(rd) = std::fs::read_dir(p) {
            for e in rd.flatten() {
                *n += 1;
                if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    walk(&e.path(), n);
                }
            }
        }
    }
    for _ in 0..2 {
        let t = Instant::now();
        let mut n = 0usize;
        walk(std::path::Path::new(&root), &mut n);
        println!("std::fs recursive count-only: {:?} n={}", t.elapsed(), n);
    }
}

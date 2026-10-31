//! In-memory compact block cache. `sync::run` downloads a batch, scans it and
//! deletes it, so nothing needs to survive a restart and nothing hits the disk.

use std::{collections::BTreeMap, fmt, sync::Mutex};

use async_trait::async_trait;
use zcash_client_backend::{
    data_api::{
        chain::{BlockCache, BlockSource, error::Error as ChainError},
        scanning::ScanRange,
    },
    proto::compact_formats::CompactBlock,
};
use zcash_protocol::consensus::BlockHeight;

#[derive(Debug)]
pub struct CacheError(String);

impl fmt::Display for CacheError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "block cache: {}", self.0)
    }
}

impl std::error::Error for CacheError {}

#[derive(Default)]
pub struct MemoryBlockCache {
    blocks: Mutex<BTreeMap<u32, CompactBlock>>,
}

fn height_of(b: &CompactBlock) -> Result<u32, CacheError> {
    u32::try_from(b.height)
        .map_err(|_| CacheError(format!("block height {} out of range", b.height)))
}

impl MemoryBlockCache {
    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<u32, CompactBlock>> {
        // A poisoned lock only means a scan panicked mid-way; the map is still usable.
        self.blocks.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.lock().len()
    }
}

impl BlockSource for MemoryBlockCache {
    type Error = CacheError;

    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), ChainError<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), ChainError<WalletErrT, Self::Error>>,
    {
        let start = from_height.map(u32::from).unwrap_or(0);
        // Clone the batch out so the scanner never runs while holding the lock.
        let batch: Vec<CompactBlock> = self
            .lock()
            .range(start..)
            .take(limit.unwrap_or(usize::MAX))
            .map(|(_, b)| b.clone())
            .collect();
        for block in batch {
            with_block(block)?;
        }
        Ok(())
    }
}

#[async_trait]
impl BlockCache for MemoryBlockCache {
    fn get_tip_height(&self, range: Option<&ScanRange>) -> Result<Option<BlockHeight>, CacheError> {
        let blocks = self.lock();
        let tip = match range {
            Some(r) => {
                let (start, end) = (
                    u32::from(r.block_range().start),
                    u32::from(r.block_range().end),
                );
                blocks.range(start..end).next_back().map(|(h, _)| *h)
            }
            None => blocks.keys().next_back().copied(),
        };
        Ok(tip.map(BlockHeight::from_u32))
    }

    async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, CacheError> {
        let (start, end) = (
            u32::from(range.block_range().start),
            u32::from(range.block_range().end),
        );
        let blocks = self.lock();
        // Short read: stop at the first gap.
        Ok((start..)
            .zip(blocks.range(start..end))
            .take_while(|(expected, (h, _))| *h == expected)
            .map(|(_, (_, b))| b.clone())
            .collect())
    }

    async fn insert(&self, compact_blocks: Vec<CompactBlock>) -> Result<(), CacheError> {
        let mut blocks = self.lock();
        for b in compact_blocks {
            blocks.insert(height_of(&b)?, b);
        }
        Ok(())
    }

    async fn delete(&self, range: ScanRange) -> Result<(), CacheError> {
        let (start, end) = (
            u32::from(range.block_range().start),
            u32::from(range.block_range().end),
        );
        let mut blocks = self.lock();
        let doomed: Vec<u32> = blocks.range(start..end).map(|(h, _)| *h).collect();
        for h in doomed {
            blocks.remove(&h);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zcash_client_backend::data_api::scanning::ScanPriority;

    fn block(h: u64) -> CompactBlock {
        CompactBlock {
            height: h,
            ..Default::default()
        }
    }

    fn range(a: u32, b: u32) -> ScanRange {
        ScanRange::from_parts(
            BlockHeight::from_u32(a)..BlockHeight::from_u32(b),
            ScanPriority::Historic,
        )
    }

    #[tokio::test]
    async fn insert_read_delete_truncate() {
        let c = MemoryBlockCache::default();
        c.insert(vec![block(10), block(11), block(12), block(14)])
            .await
            .unwrap();
        assert_eq!(
            c.get_tip_height(None).unwrap(),
            Some(BlockHeight::from_u32(14))
        );
        assert_eq!(
            c.get_tip_height(Some(&range(10, 13))).unwrap(),
            Some(BlockHeight::from_u32(12))
        );

        // Short read stops at the gap at 13.
        let read = c.read(&range(10, 15)).await.unwrap();
        assert_eq!(
            read.iter().map(|b| b.height).collect::<Vec<_>>(),
            vec![10, 11, 12]
        );

        let mut seen = vec![];
        c.with_blocks::<_, ()>(Some(BlockHeight::from_u32(11)), Some(2), |b| {
            seen.push(b.height);
            Ok(())
        })
        .unwrap();
        assert_eq!(seen, vec![11, 12]);

        c.truncate(BlockHeight::from_u32(11)).await.unwrap();
        assert_eq!(
            c.get_tip_height(None).unwrap(),
            Some(BlockHeight::from_u32(11))
        );

        c.delete(range(0, 100)).await.unwrap();
        assert_eq!(c.len(), 0);
        assert_eq!(c.get_tip_height(None).unwrap(), None);
    }
}

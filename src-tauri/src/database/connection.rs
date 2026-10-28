use std::path::Path;

use rusqlite::{Connection, OpenFlags};

use crate::domain::bootstrap::BootstrapError;

pub fn open_database(database_path: &Path) -> Result<Connection, BootstrapError> {
    open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )
}

pub fn open_existing_database(database_path: &Path) -> Result<Connection, BootstrapError> {
    open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
}

fn open_with_flags(database_path: &Path, flags: OpenFlags) -> Result<Connection, BootstrapError> {
    let connection = Connection::open_with_flags(database_path, flags)
        .map_err(BootstrapError::from_database_error)?;

    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(BootstrapError::from_database_error)?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(BootstrapError::from_database_error)?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(BootstrapError::from_database_error)?;
    connection
        .busy_timeout(std::time::Duration::from_millis(5_000))
        .map_err(BootstrapError::from_database_error)?;

    Ok(connection)
}

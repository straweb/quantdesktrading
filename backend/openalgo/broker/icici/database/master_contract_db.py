"""
ICICI Direct SecurityMaster -> OpenAlgo symtoken table.

The ICICI master archive (SecurityMaster.zip) contains per-segment CSVs:

    NSEScripMaster.txt / BSEScripMaster.txt     equities (+ indices rows)
    FONSEScripMaster.txt / FOBSEScripMaster.txt NFO / BFO derivatives
    MCXScripMaster.txt                          MCX derivatives

Row shapes (0-based columns):

    NSE/BSE : token, stock_code, ?, company_name
    NFO/BFO : token, ?, underlying, product(FUT/OPT), expiry, strike,
              option_type(CE/PE), ..., lot_size, tick_size
    MCX     : token, ?, underlying, product, ..., option_type, expiry,
              ..., strike, lot_size

OpenAlgo symbols follow the common format:

    equities  RELIANCE-EQ
    futures   NIFTY19OCT26FUT
    options   NIFTY19OCT2623650CE
"""

import csv
import io
import os
import zipfile
from datetime import datetime

import pandas as pd
import requests
from sqlalchemy import (
    Column,
    Float,
    Index,
    Integer,
    Sequence,
    String,
    create_engine,
)
from sqlalchemy.orm import (
    declarative_base,
    scoped_session,
    sessionmaker,
)

from extensions import socketio
from utils.logging import get_logger


logger = get_logger(__name__)


DATABASE_URL = os.getenv("DATABASE_URL")

engine = create_engine(DATABASE_URL)

db_session = scoped_session(
    sessionmaker(
        autocommit=False,
        autoflush=False,
        bind=engine,
    )
)

Base = declarative_base()

Base.query = db_session.query_property()


class SymToken(Base):
    __tablename__ = "symtoken"

    id = Column(
        Integer,
        Sequence("symtoken_id_seq"),
        primary_key=True,
    )

    symbol = Column(String, nullable=False, index=True)
    brsymbol = Column(String, nullable=False, index=True)
    name = Column(String)
    exchange = Column(String, index=True)
    brexchange = Column(String, index=True)
    token = Column(String, index=True)
    expiry = Column(String)
    strike = Column(Float)
    lotsize = Column(Integer)
    instrumenttype = Column(String)
    tick_size = Column(Float)

    __table_args__ = (
        Index("idx_icici_symbol_exchange", "symbol", "exchange"),
    )


SECURITY_MASTER_URL = (
    "https://directlink.icicidirect.com/MotherAppMaster/SecurityMaster.zip"
)


def init_db():
    Base.metadata.create_all(bind=engine)


def delete_icici_tokens():
    db_session.query(SymToken).filter(
        SymToken.exchange.in_(["NSE", "BSE", "NFO", "BFO", "MCX"])
    ).delete(synchronize_session=False)

    db_session.commit()


def copy_from_dataframe(df):
    records = df.to_dict(orient="records")

    if not records:
        return

    db_session.bulk_insert_mappings(SymToken, records)

    db_session.commit()


def clean(value):
    if value is None:
        return ""

    return str(value).strip().strip('"')


def parse_float(value, default=0.0):
    try:
        return float(clean(value))
    except Exception:
        return default


def parse_int(value, default=1):
    try:
        return int(float(clean(value)))
    except Exception:
        return default


def expiry_dd_mmm_yy(value) -> str:
    """Normalise any ICICI expiry spelling to the OpenAlgo 19OCT26 form."""

    value = clean(value)

    if not value:
        return ""

    for fmt in (
        "%d-%b-%Y",
        "%d-%b-%y",
        "%Y-%m-%d",
        "%d/%m/%Y",
    ):
        try:
            return datetime.strptime(value, fmt).strftime("%d%b%y").upper()
        except ValueError:
            continue

    return value.upper()


def strike_rupees(value) -> float:
    """
    ICICI stores strikes in paise-like integer form (2500000 -> 25000).
    Values below 100 are already rupees.
    """

    try:
        number = float(clean(value))

        if abs(number) >= 100:
            number /= 100

        return number

    except Exception:
        return 0.0


def _format_strike(strike_value: float) -> str:
    if strike_value.is_integer():
        return str(int(strike_value))

    return str(strike_value)


def contract_symbol(
    underlying: str,
    product_type: str,
    expiry: str,
    strike: str,
    option_type: str,
) -> str:
    underlying = clean(underlying).upper()

    product_type = clean(product_type).upper()

    if "FUT" in product_type:
        return f"{underlying}{expiry}FUT"

    right = clean(option_type).upper()

    if "C" in right:
        right = "CE"
    elif "P" in right:
        right = "PE"
    else:
        return ""

    strike_value = strike_rupees(strike)

    return f"{underlying}{expiry}{_format_strike(strike_value)}{right}"


def parse_file(filename: str, content: bytes) -> list:
    upper = filename.upper()

    if "FONSE" in upper:
        exchange = "NFO"
    elif "FOBSE" in upper:
        exchange = "BFO"
    elif "MCX" in upper:
        exchange = "MCX"
    elif "NSE" in upper:
        exchange = "NSE"
    elif "BSE" in upper:
        exchange = "BSE"
    else:
        return []

    rows = []

    reader = csv.reader(
        io.TextIOWrapper(io.BytesIO(content), encoding="utf-8", errors="replace")
    )

    for columns in reader:
        if len(columns) < 5:
            continue

        columns = [clean(x) for x in columns]

        try:
            token = columns[0]

            if not token:
                continue

            # ----------------------------------------------------------
            # NSE / BSE cash equities (and index rows when present)
            # ----------------------------------------------------------
            if exchange in ("NSE", "BSE"):
                brsymbol = columns[1]

                if not brsymbol:
                    continue

                name = columns[3] if len(columns) > 3 else brsymbol

                rows.append(
                    {
                        "symbol": f"{brsymbol}-EQ",
                        "brsymbol": brsymbol,
                        "name": name,
                        "exchange": exchange,
                        "brexchange": exchange,
                        "token": token,
                        "expiry": "",
                        "strike": 0.0,
                        "lotsize": 1,
                        "instrumenttype": "EQ",
                        "tick_size": 0.05,
                    }
                )

                continue

            # ----------------------------------------------------------
            # NFO / BFO derivatives
            # ----------------------------------------------------------
            if exchange in ("NFO", "BFO"):
                if len(columns) < 7:
                    continue

                underlying = columns[2]
                product_type = columns[3]
                expiry = expiry_dd_mmm_yy(columns[4])
                strike = columns[5]
                option_type = columns[6]

                symbol = contract_symbol(
                    underlying, product_type, expiry, strike, option_type
                )

                if not symbol:
                    continue

                instrument_type = (
                    "FUT"
                    if "FUT" in product_type.upper()
                    else ("CE" if "C" in option_type.upper() else "PE")
                )

                lotsize = parse_int(columns[8], 1) if len(columns) > 8 else 1

                tick_size = (
                    parse_float(columns[9], 0.05) if len(columns) > 9 else 0.05
                )

                rows.append(
                    {
                        "symbol": symbol,
                        "brsymbol": symbol,
                        "name": clean(underlying).upper(),
                        "exchange": exchange,
                        "brexchange": exchange,
                        "token": token,
                        "expiry": expiry,
                        "strike": strike_rupees(strike),
                        "lotsize": lotsize,
                        "instrumenttype": instrument_type,
                        "tick_size": tick_size,
                    }
                )

                continue

            # ----------------------------------------------------------
            # MCX derivatives
            # ----------------------------------------------------------
            if exchange == "MCX":
                if len(columns) < 10:
                    continue

                underlying = columns[2]
                product_type = columns[3]
                expiry = expiry_dd_mmm_yy(columns[7])
                strike = columns[9]
                option_type = columns[8]

                symbol = contract_symbol(
                    underlying, product_type, expiry, strike, option_type
                )

                if not symbol:
                    continue

                instrument_type = (
                    "FUT"
                    if "FUT" in product_type.upper()
                    else ("CE" if "C" in option_type.upper() else "PE")
                )

                lotsize = parse_int(columns[10], 1) if len(columns) > 10 else 1

                rows.append(
                    {
                        "symbol": symbol,
                        "brsymbol": symbol,
                        "name": clean(underlying).upper(),
                        "exchange": "MCX",
                        "brexchange": "MCX",
                        "token": token,
                        "expiry": expiry,
                        "strike": strike_rupees(strike),
                        "lotsize": lotsize,
                        "instrumenttype": instrument_type,
                        "tick_size": 0.05,
                    }
                )

        except Exception:
            logger.exception("Error parsing ICICI master row in %s", filename)

    return rows


def master_contract_download() -> bool:
    try:
        logger.info("Starting ICICI Direct SecurityMaster download")

        init_db()

        response = requests.get(SECURITY_MASTER_URL, timeout=120)

        response.raise_for_status()

        rows = []

        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            for filename in archive.namelist():
                if not filename.lower().endswith(".txt"):
                    continue

                rows.extend(
                    parse_file(filename, archive.read(filename))
                )

        if not rows:
            raise RuntimeError(
                "ICICI SecurityMaster contained no usable instruments"
            )

        df = pd.DataFrame(rows)

        # One broker token per exchange.
        df = df.drop_duplicates(subset=["exchange", "token"])

        delete_icici_tokens()

        copy_from_dataframe(df)

        logger.info("ICICI Direct master contract loaded: %d rows", len(df))

        socketio.emit(
            "master_contract_download",
            {
                "status": "success",
                "broker": "icici",
                "count": len(df),
            },
        )

        return True

    except Exception as exc:
        db_session.rollback()

        logger.exception("ICICI master contract download failed")

        socketio.emit(
            "master_contract_download",
            {
                "status": "error",
                "broker": "icici",
                "message": str(exc),
            },
        )

        return False

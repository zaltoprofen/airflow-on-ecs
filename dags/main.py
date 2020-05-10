from datetime import datetime, timedelta

from airflow import DAG

from tasks.greet import greet

default_args = {
    'owner': 'zaltoprofen',
    'start_date': datetime(2020, 5, 1),
    'depends_on_past': False,
}


with DAG(
    dag_id='main',
    schedule_interval=timedelta(minutes=10),
    catchup=False,
    default_args=default_args,
) as main:
    t1 = greet(task_id='greet1')
    t2 = greet(task_id='greet2', message='good bye.')
    t1 >> t2